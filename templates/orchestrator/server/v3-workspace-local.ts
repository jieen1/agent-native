// Host-native (non-microVM) V3 workspace adapter (DESIGN §10.6, §13).
//
// In the Docker deployment `MicrosandboxRuntime` (msb / libkrun / KVM) is NOT
// available, so the long-lived workspace VM model of `server/engine/v3-workspace.ts`
// cannot run. This module implements orca's git-worktree model instead: a
// workspace is a REAL `git clone` checkout in a directory on a host volume, and
// the agent workers `cwd` into that directory. Git runs HOST-NATIVE over
// `node:child_process` (NOT MicrosandboxRuntime).
//
// Lifecycle:
//   createLocalWorkspace  → git clone into ${WORKSPACE_ROOT}/<id>, cut + checkout
//                           the run branch, insert a `v3_workspaces` row (state
//                           `ready`, host_path = the local dir).
//   getLocalWorkspaceDir  → the local dir for a workspace id (the worker cwd).
//   destroyLocalWorkspace → rm -rf the dir + mark the row `destroyed`.
//   commitAndPush         → git add -A && commit, push the branch, optionally
//                           open an MR (PR) and return its URL.
//
// Auth (DESIGN §13): GITHUB_TOKEN is resolved EPHEMERALLY (process.env, or the
// framework Vault via resolveSecret when available) and injected into the
// clone/push remote URL as `https://x-access-token:$TOKEN@github.com/...`. The
// token is NEVER persisted in `.git/config`: the clone runs against the auth URL
// but `origin` is reset to the clean URL immediately after, and each push uses a
// one-shot auth URL passed to a single `git push <url>` invocation. `file://`
// repo URLs are supported token-less (for cloning a local path with no token).

import { spawn } from "node:child_process";
import { readFile, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { join, normalize, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";

import { getV3Db, v3Schema, LOCAL_DEFAULT_OWNER } from "./db/v3.js";

// ── Config ─────────────────────────────────────────────────────────────────

/** Root volume directory that holds one checkout per workspace id. */
export const WORKSPACE_ROOT = process.env.ORCH_WORKSPACE_ROOT || "/workspaces";

/**
 * Workspace isolation strategy:
 *  - "worktree" (default): one shared bare mirror per repo under
 *    `${WORKSPACE_ROOT}/.bare/<sha256(repoUrl)>`, and each workspace is a
 *    `git worktree add` of that mirror on its own branch. Cheap + fast: two
 *    concurrent tasks on the same repo share the object store but get fully
 *    isolated checkouts on separate branches.
 *  - "clone": the original full `git clone` per workspace (still supported).
 */
export type WorkspaceIsolation = "worktree" | "clone";

/** Resolve the configured isolation strategy (default worktree). */
export function getWorkspaceIsolation(): WorkspaceIsolation {
  const raw = (process.env.ORCH_WORKSPACE_ISOLATION || "worktree")
    .trim()
    .toLowerCase();
  return raw === "clone" ? "clone" : "worktree";
}

/** Directory holding the per-repo bare mirrors (worktree mode). */
export const BARE_ROOT = `${WORKSPACE_ROOT}/.bare`;

/** Deterministic bare-mirror dir for a repo URL (sha256 of the clean URL). */
export function bareMirrorDir(repoUrl: string): string {
  const sha = createHash("sha256").update(repoUrl.trim()).digest("hex");
  return `${BARE_ROOT}/${sha}`;
}

/** Generous git timeout — a clone over slow egress can take a while. */
const GIT_TIMEOUT_MS = 180_000;

/** Deterministic non-secret bot identity so commits succeed (mirrors §7.1a). */
const BOT_EMAIL = "orchestrator@an.local";
const BOT_NAME = "Orchestrator Run";

// ── Types ──────────────────────────────────────────────────────────────────

/** Options for {@link createLocalWorkspace}. */
export interface CreateLocalWorkspaceOptions {
  /** Git repo to clone — `https://github.com/...`, `https://...`, or `file://...`. */
  repoUrl: string;
  /** Run branch to create + checkout. Defaults to `orchestrator/run-<id>`. */
  branch?: string;
  /**
   * Base ref to cut the run branch FROM (e.g. `main`, or a feature branch). This
   * is NOT checked out itself — the fresh run branch is created from it — so it
   * never collides under concurrency. Defaults to the mirror's resolved base ref
   * (origin/HEAD → main). Pass the project's default branch here.
   */
  baseRef?: string;
  /** What owns this workspace (e.g. "run" or "user"). */
  ownerKind: string;
  /** The owner's id (e.g. the run id, or the user's email). */
  ownerId: string;
  /**
   * Audit identity for the `created_by` column — the real requesting user's
   * email when a person creates the workspace, or a system/run identifier.
   * Defaults to `<ownerKind>:<ownerId>` when not supplied.
   */
  createdBy?: string;
  /**
   * SECURITY — the framework `ownableColumns()` owner-scope identity
   * (`resolveOwnerEmail()` at the call site: `getRequestUserEmail() ?? "local@localhost"`,
   * or the equivalent already-resolved identity carried on a background task
   * row). This is what every workspace action's fail-closed owner filter
   * checks directly. Defaults to `LOCAL_DEFAULT_OWNER` when omitted — never
   * silently open to every owner.
   */
  ownerEmail?: string;
}

/** Result of {@link createLocalWorkspace}. */
export interface LocalWorkspace {
  /** The workspace id (also the directory name under WORKSPACE_ROOT). */
  id: string;
  /** Absolute local directory of the checkout (the worker cwd). */
  dir: string;
  /** The branch checked out in `dir`. */
  branch: string;
}

/** Options for {@link commitAndPush}. */
export interface CommitAndPushOptions {
  /** The workspace id. */
  id: string;
  /** Commit message. */
  message: string;
  /** When true, open a PR/MR after pushing (via `gh` or the GitHub API). */
  createMr?: boolean;
  /** Base branch for the PR. Defaults to the repo default (gh resolves it). */
  baseBranch?: string;
  /** PR title. Defaults to the commit message. */
  prTitle?: string;
  /** PR body. */
  prBody?: string;
}

/** Result of {@link commitAndPush}. */
export interface CommitAndPushResult {
  /** True when a new commit was created (false on a clean tree — not an error). */
  committed: boolean;
  /** The new commit sha, or null when nothing was committed. */
  sha: string | null;
  /** True when the branch was pushed to the remote. */
  pushed: boolean;
  /** The branch that was pushed. */
  branch: string;
  /** The PR/MR URL when `createMr` was requested AND a real PR was opened. */
  prUrl?: string;
}

// ── Git helper (host-native, argv-only — no shell, no token leak) ────────────

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run one git command host-native via `child_process.spawn` with an argv array
 * (NO shell), so token values in `args` can never be interpolated into a shell
 * or echoed to a log line a shell would expand. A non-zero exit is RETURNED
 * (never thrown): callers decide what failure means and surface git's stderr.
 * Only an inability to spawn git / a timeout rejects.
 */
function git(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new Error(`git ${args[0] ?? ""} timed out after ${GIT_TIMEOUT_MS}ms`),
      );
    }, GIT_TIMEOUT_MS);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Run `gh <args>` host-native (argv-only). Returns code+stdout+stderr. */
function gh(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new Error(`gh ${args[0] ?? ""} timed out after ${GIT_TIMEOUT_MS}ms`),
      );
    }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** True when `gh` resolves on PATH. */
async function hasGh(): Promise<boolean> {
  try {
    const res = await gh(["--version"]);
    return res.code === 0;
  } catch {
    return false;
  }
}

// ── Auth helpers (token NEVER persisted) ─────────────────────────────────────

/**
 * Resolve GITHUB_TOKEN ephemerally: framework Vault (`resolveSecret`) when the
 * server module is importable, else `process.env.GITHUB_TOKEN`. Returns null
 * when no token is configured (public / file:// clones still work).
 */
async function resolveGithubToken(): Promise<string | null> {
  try {
    const mod: { resolveSecret?: (k: string) => Promise<unknown> } =
      await import("@agent-native/core/server");
    if (typeof mod.resolveSecret === "function") {
      const resolved = await mod
        .resolveSecret("GITHUB_TOKEN")
        .catch(() => null);
      if (resolved != null && String(resolved).trim() !== "") {
        return String(resolved);
      }
    }
  } catch {
    // Framework server module not importable in this context — fall through.
  }
  const fromEnv = process.env.GITHUB_TOKEN;
  return fromEnv && fromEnv.trim() !== "" ? fromEnv : null;
}

/**
 * Build the authenticated remote URL for a clone/push. Only `https://github`
 * (and other `https://`) URLs get the ephemeral `x-access-token` prefix; a
 * `file://` (or any non-https) URL is returned unchanged (no token needed).
 */
function withToken(remoteUrl: string, token: string | null): string {
  const clean = remoteUrl.trim();
  if (!token || token.trim() === "" || !/^https:\/\//.test(clean)) {
    return clean;
  }
  return clean.replace(
    /^https:\/\/(.*)$/,
    `https://x-access-token:${token}@$1`,
  );
}

/** Redact every occurrence of `secret` from `text` (token-safe diagnostics). */
function redact(text: string, secret: string | null): string {
  if (!secret) return text;
  const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(escaped, "g"), "***");
}

/** Default per-run branch name when the caller does not pass one. */
export function defaultRunBranch(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, "-");
  return `orchestrator/run-${safe}`;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Provision a host-native workspace: `git clone` `repoUrl` into
 * `${WORKSPACE_ROOT}/<id>`, create + checkout `branch` (default
 * `orchestrator/run-<id>`), and insert a `v3_workspaces` row with state `ready`
 * and `host_path` set to the local dir.
 *
 * The clone authenticates with an EPHEMERAL `x-access-token` remote (DESIGN §13)
 * when a GITHUB_TOKEN is present and the URL is https; `origin` is then reset to
 * the clean URL so the token never lands in `.git/config`. `file://` URLs clone
 * token-less. On any failure the row is marked `error` and the partial directory
 * is cleaned up, then a descriptive error (with git stderr, token redacted) is
 * thrown.
 */
export async function createLocalWorkspace(
  opts: CreateLocalWorkspaceOptions,
): Promise<LocalWorkspace> {
  const { repoUrl, ownerKind, ownerId } = opts;
  const createdBy =
    opts.createdBy && opts.createdBy.trim() !== ""
      ? opts.createdBy.trim()
      : `${ownerKind}:${ownerId}`;
  // SECURITY — populate the real owner-scope identity at create time so every
  // workspace action's fail-closed owner filter can match directly, instead of
  // relying solely on the ownerKind==="run" join through v3_runs. Never leave
  // this at the column default when the caller resolved a real identity.
  const ownerEmail =
    opts.ownerEmail && opts.ownerEmail.trim() !== ""
      ? opts.ownerEmail.trim()
      : LOCAL_DEFAULT_OWNER;
  const db = getV3Db();

  const id = crypto.randomUUID();
  const dir = `${WORKSPACE_ROOT}/${id}`;
  const branch =
    opts.branch && opts.branch.trim() !== ""
      ? opts.branch.trim()
      : defaultRunBranch(id);

  const token = await resolveGithubToken();

  // Step 0: insert the provisioning row (fail-fast bookkeeping).
  await db.insert(v3Schema.v3Workspaces).values({
    id,
    ownerKind,
    ownerId,
    tags: {} as Record<string, string>,
    vmName: null,
    repoUrl,
    branch,
    state: "provisioning",
    createdAt: new Date(),
    destroyedAt: null,
    createdBy,
    hostPath: dir,
    ownerEmail,
  });

  try {
    if (getWorkspaceIsolation() === "worktree") {
      await provisionWorktree({
        repoUrl,
        dir,
        branch,
        token,
        baseRef: opts.baseRef?.trim() || undefined,
      });
    } else {
      await provisionClone({ repoUrl, dir, branch, token });
    }

    // Mark the row ready.
    await db
      .update(v3Schema.v3Workspaces)
      .set({ state: "ready" })
      .where(eq(v3Schema.v3Workspaces.id, id));

    return { id, dir, branch };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Mark the row error and clean up the partial checkout (best-effort). In
    // worktree mode also detach the half-added worktree from the mirror.
    await db
      .update(v3Schema.v3Workspaces)
      .set({ state: "error" })
      .where(eq(v3Schema.v3Workspaces.id, id))
      .catch(() => {});
    if (getWorkspaceIsolation() === "worktree") {
      const bare = bareMirrorDir(repoUrl);
      await git(["-C", bare, "worktree", "remove", "--force", dir]).catch(
        () => {},
      );
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`createLocalWorkspace failed for ${repoUrl}: ${message}`);
  }
}

/**
 * Full `git clone` per workspace (the original "clone" strategy). Clones into
 * `dir`, resets `origin` to the clean URL (token never persisted), sets the bot
 * identity, and cuts + checks out `branch`.
 */
async function provisionClone(opts: {
  repoUrl: string;
  dir: string;
  branch: string;
  token: string | null;
}): Promise<void> {
  const { repoUrl, dir, branch, token } = opts;
  const cloneUrl = withToken(repoUrl, token);
  const cloned = await git(["clone", "--no-single-branch", cloneUrl, dir]);
  if (cloned.code !== 0) {
    throw new Error(
      `git clone failed (exit ${cloned.code}): ` +
        redact(`${cloned.stdout}\n${cloned.stderr}`.trim(), token),
    );
  }
  await git(["remote", "set-url", "origin", repoUrl.trim()], { cwd: dir });
  await git(["config", "user.email", BOT_EMAIL], { cwd: dir });
  await git(["config", "user.name", BOT_NAME], { cwd: dir });
  const checkout = await git(["checkout", "-B", branch], { cwd: dir });
  if (checkout.code !== 0) {
    throw new Error(
      `git checkout -B ${branch} failed (exit ${checkout.code}): ` +
        redact(`${checkout.stdout}\n${checkout.stderr}`.trim(), token),
    );
  }
}

/**
 * Git-worktree isolation. Maintains ONE shared bare mirror per repo at
 * `bareMirrorDir(repoUrl)` (cloned once with `--bare`, then `fetch`-ed to refresh)
 * and adds an isolated worktree at `dir` on a fresh `branch` cut from the repo
 * base ref. Two concurrent tasks on the same repo share the object store but get
 * two separate worktrees on two separate branches.
 *
 * The bare mirror's `origin` is reset to the clean URL after the auth fetch, so
 * the token never lands in `.git/config`. The worktree's checkout reuses the
 * mirror's config (bot identity set on the worktree itself for commits).
 */
async function provisionWorktree(opts: {
  repoUrl: string;
  dir: string;
  branch: string;
  token: string | null;
  /** Explicit base ref to cut the run branch from (e.g. the project branch). */
  baseRef?: string;
}): Promise<void> {
  const { repoUrl, dir, branch, token } = opts;
  const bare = bareMirrorDir(repoUrl);

  // 1) Ensure the bare mirror exists + is reasonably fresh. Serialize concurrent
  //    creators with a coarse advisory lock keyed on the mirror dir so two tasks
  //    racing the first clone don't collide.
  await ensureBareMirror({ repoUrl, bare, token });

  // 2) Resolve the base ref to cut the worktree branch from. When the caller
  //    pins one (the project's default branch), fetch its fresh tip from origin
  //    so we cut from the real upstream commit (not a stale local ref), then use
  //    FETCH_HEAD. Otherwise fall back to the mirror's default-branch tip.
  let baseRef: string;
  if (opts.baseRef && opts.baseRef.trim()) {
    const wanted = opts.baseRef.trim();
    const fetchUrl = withToken(repoUrl, token);
    // Fetch the wanted branch into FETCH_HEAD only (NOT into refs/heads/<branch>)
    // — updating a local head git refuses when another worktree already has that
    // branch checked out. FETCH_HEAD always carries the fresh upstream commit and
    // is a valid base ref for `worktree add`.
    const fetched = await git([
      "-C",
      bare,
      "fetch",
      "--no-tags",
      fetchUrl,
      `refs/heads/${wanted}`,
    ]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    // Reset origin back to the clean URL so the token never persists.
    await git(["-C", bare, "remote", "set-url", "origin", repoUrl]).catch(
      () => {},
    );
    baseRef =
      fetched.code === 0
        ? "FETCH_HEAD"
        : // Fetch failed (e.g. branch not on remote) — fall back gracefully.
          await resolveBareBaseRef(bare);
  } else {
    baseRef = await resolveBareBaseRef(bare);
  }

  // 3) Add the worktree on a fresh branch from the base ref. -B is idempotent on
  //    the branch; the worktree dir must not pre-exist.
  await mkdir(WORKSPACE_ROOT, { recursive: true }).catch(() => {});
  const added = await git(
    ["-C", bare, "worktree", "add", "-B", branch, dir, baseRef],
    {},
  );
  if (added.code !== 0) {
    throw new Error(
      `git worktree add ${dir} (${branch} from ${baseRef}) failed ` +
        `(exit ${added.code}): ` +
        redact(`${added.stdout}\n${added.stderr}`.trim(), token),
    );
  }

  // 4) Deterministic bot identity on the worktree so commits succeed. The
  //    worktree shares the mirror's origin (clean URL); pushes re-inject the
  //    token via a one-shot auth URL exactly like the clone path.
  await git(["config", "user.email", BOT_EMAIL], { cwd: dir });
  await git(["config", "user.name", BOT_NAME], { cwd: dir });
}

/**
 * Ensure a bare mirror exists at `bare` for `repoUrl`. Creates it with
 * `git clone --bare` (auth URL, then origin reset to the clean URL) on first
 * use; refreshes it with `git fetch origin` (auth URL one-shot) when it already
 * exists, so a second task sees recent upstream commits. Best-effort fetch — a
 * fetch failure on an existing mirror is non-fatal (we still have objects).
 */
async function ensureBareMirror(opts: {
  repoUrl: string;
  bare: string;
  token: string | null;
}): Promise<void> {
  const { repoUrl, bare, token } = opts;
  await mkdir(BARE_ROOT, { recursive: true }).catch(() => {});

  // Probe whether the bare mirror already exists (and is a real bare repo).
  const isRepo =
    (await git(["-C", bare, "rev-parse", "--is-bare-repository"]).catch(() => ({
      code: 1,
      stdout: "",
      stderr: "",
    }))).stdout.trim() === "true";

  if (!isRepo) {
    const cloneUrl = withToken(repoUrl, token);
    const cloned = await git(["clone", "--bare", cloneUrl, bare]);
    if (cloned.code !== 0) {
      // Clean up a partial bare dir so a retry starts fresh.
      await rm(bare, { recursive: true, force: true }).catch(() => {});
      throw new Error(
        `git clone --bare failed (exit ${cloned.code}): ` +
          redact(`${cloned.stdout}\n${cloned.stderr}`.trim(), token),
      );
    }
    // Drop the token from the mirror's persisted remote.
    await git(["-C", bare, "remote", "set-url", "origin", repoUrl.trim()]);
    // Make origin/HEAD resolvable so resolveBareBaseRef can find the default.
    await git(["-C", bare, "remote", "set-head", "origin", "-a"]).catch(
      () => {},
    );
    return;
  }

  // Existing mirror — refresh from upstream (one-shot auth URL, never persisted).
  const fetchUrl = withToken(repoUrl, token);
  await git(["-C", bare, "fetch", "--prune", fetchUrl, "+refs/heads/*:refs/heads/*"]).catch(
    () => {},
  );
  await git(["-C", bare, "remote", "set-head", "origin", "-a"]).catch(() => {});
}

/** Resolve the base ref for a new worktree branch from the bare mirror. */
async function resolveBareBaseRef(bare: string): Promise<string> {
  // Prefer the mirror's default branch (origin/HEAD → e.g. refs/heads/main).
  const head = await git(
    ["-C", bare, "symbolic-ref", "--short", "HEAD"],
    {},
  ).catch(() => null);
  if (head && head.code === 0 && head.stdout.trim()) {
    return head.stdout.trim();
  }
  for (const ref of ["main", "master"]) {
    const ok = await git(["-C", bare, "rev-parse", "--verify", ref]).catch(
      () => null,
    );
    if (ok && ok.code === 0) return ref;
  }
  // Last resort — current HEAD of the bare repo.
  return "HEAD";
}

/**
 * Prune orphaned git worktrees across all bare mirrors. A destroyed workspace's
 * worktree dir is removed by destroyLocalWorkspace, but a crash can leave a
 * worktree registered with no dir; `git worktree prune` clears those. Best-effort.
 */
export async function pruneOrphanedWorktrees(): Promise<void> {
  if (getWorkspaceIsolation() !== "worktree") return;
  const mirrors = await readdir(BARE_ROOT, { withFileTypes: true }).catch(
    () => [],
  );
  for (const m of mirrors) {
    if (!m.isDirectory()) continue;
    const bare = join(BARE_ROOT, m.name);
    await git(["-C", bare, "worktree", "prune"]).catch(() => {});
  }
}

/**
 * Return the absolute local checkout directory for a workspace id, or null when
 * the workspace is unknown or has no `host_path` (e.g. a microVM workspace).
 * This is the value the dispatcher passes as the worker cwd.
 */
export async function getLocalWorkspaceDir(id: string): Promise<string | null> {
  const db = getV3Db();
  const [row] = await db
    .select({
      hostPath: v3Schema.v3Workspaces.hostPath,
      state: v3Schema.v3Workspaces.state,
    })
    .from(v3Schema.v3Workspaces)
    .where(eq(v3Schema.v3Workspaces.id, id))
    .limit(1);

  if (!row || !row.hostPath || row.state === "destroyed") {
    return null;
  }
  return row.hostPath;
}

// ── Host-native read surface (diff / list / read) ───────────────────────────
//
// The VM read path (MicrosandboxRuntime) is unavailable for host-native
// workspaces (vm_name NULL, host_path set). These helpers serve the same three
// reads — diff, file list, file content — host-native over the checkout dir, so
// the workspace UI works without a microVM. All are read-only.

/** One changed file in a workspace diff, with line counts + its unified patch. */
export interface LocalDiffFile {
  /** Repo-relative path (the new path for renames). */
  path: string;
  /** Lines added in this file's patch. */
  additions: number;
  /** Lines removed in this file's patch. */
  deletions: number;
  /** Git status letter: A(dded) M(odified) D(eleted) R(enamed) … */
  status: string;
  /** The unified-diff hunk text for just this file. */
  patch: string;
}

/** Result of {@link localWorkspaceDiff}: the raw patch plus a per-file split. */
export interface LocalDiffResult {
  /** The full `git diff` text (all files concatenated). */
  diff: string;
  /** Per-file breakdown (path + add/del counts + that file's patch). */
  files: LocalDiffFile[];
  /** The base ref the diff was taken against (e.g. a merge-base sha or `main`). */
  base: string;
}

/**
 * Compute the diff for a host-native workspace.
 *
 * The run branch's work is typically already COMMITTED (a commit node ran
 * `git commit`), so a bare `git diff HEAD` (working tree vs HEAD) is empty.
 * To surface BOTH committed branch work AND any uncommitted edits, we diff
 * against the divergence point from the default branch:
 *
 *   base = git merge-base origin/main HEAD   (fallbacks: origin/master, main, master)
 *   git diff <base>                          (two-dot: working tree vs base)
 *
 * Two-dot (not three-dot) is deliberate: it includes uncommitted working-tree
 * changes too, so a workspace mid-edit still shows its diff. When `against` is
 * supplied it overrides the computed base. A workspace with no host_path
 * returns null (caller falls back to the VM path).
 */
export async function localWorkspaceDiff(
  id: string,
  against?: string,
): Promise<LocalDiffResult | null> {
  const dir = await getLocalWorkspaceDir(id);
  if (!dir) return null;

  const base = against?.trim() || (await resolveDiffBase(dir));

  // Numstat → reliable per-file add/del counts (handles renames/binaries).
  const numstat = await git(["--no-pager", "diff", "--numstat", base], {
    cwd: dir,
  });
  // Name-status → the change letter (A/M/D/R…) per file.
  const nameStatus = await git(["--no-pager", "diff", "--name-status", base], {
    cwd: dir,
  });
  // Full patch text (split per-file below).
  const full = await git(["--no-pager", "diff", base], { cwd: dir });

  const statusByPath = parseNameStatus(nameStatus.stdout);
  const patchByPath = splitUnifiedDiff(full.stdout);

  const files: LocalDiffFile[] = numstat.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      // numstat columns: "<added>\t<deleted>\t<path>" ("-" for binary files).
      const m = /^(\S+)\t(\S+)\t(.+)$/.exec(line);
      if (!m) return null;
      const [, addRaw, delRaw, rawPath] = m;
      // Renames appear as "old => new" or "{a => b}/c"; take the resolved path.
      const path = normalizeNumstatPath(rawPath);
      return {
        path,
        additions: addRaw === "-" ? 0 : Number(addRaw) || 0,
        deletions: delRaw === "-" ? 0 : Number(delRaw) || 0,
        status: statusByPath.get(path) ?? "M",
        patch: patchByPath.get(path) ?? "",
      };
    })
    .filter((f): f is LocalDiffFile => f !== null);

  return { diff: full.stdout, files, base };
}

/** Resolve the divergence base for a workspace diff. Best-effort with fallbacks. */
async function resolveDiffBase(dir: string): Promise<string> {
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    const mb = await git(["merge-base", ref, "HEAD"], { cwd: dir }).catch(
      () => null,
    );
    if (mb && mb.code === 0 && mb.stdout.trim()) return mb.stdout.trim();
  }
  // No upstream to compare against — fall back to the parent commit so at least
  // the latest commit's changes render; if even that fails, the empty tree.
  const parent = await git(["rev-parse", "HEAD~1"], { cwd: dir }).catch(
    () => null,
  );
  if (parent && parent.code === 0 && parent.stdout.trim()) {
    return parent.stdout.trim();
  }
  // Git's well-known empty-tree object — diffs the whole HEAD as additions.
  return "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
}

/** Parse `git diff --name-status` into path → status-letter. */
function parseNameStatus(out: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    const status = parts[0]?.[0] ?? "M";
    // Renames/copies report the destination path last.
    const path = parts[parts.length - 1];
    if (path) map.set(path, status);
  }
  return map;
}

/** Resolve a numstat path token (handles `{a => b}/c` and `a => b` rename forms). */
function normalizeNumstatPath(raw: string): string {
  if (raw.includes(" => ")) {
    // "{old => new}/rest" → "new/rest"; "old => new" → "new".
    const braced = /\{(.*?) => (.*?)\}/.exec(raw);
    if (braced) return raw.replace(braced[0], braced[2]);
    const simple = / => /.exec(raw);
    if (simple) return raw.slice(simple.index + simple[0].length);
  }
  return raw;
}

/** Split a full `git diff` into a map of repo-relative path → that file's patch. */
function splitUnifiedDiff(full: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!full.trim()) return map;
  // Each file section starts at a "diff --git a/<x> b/<y>" header.
  const chunks = full.split(/(?=^diff --git )/m);
  for (const chunk of chunks) {
    if (!chunk.startsWith("diff --git")) continue;
    // Prefer the +++ b/<path> header; fall back to the "b/<path>" in --git.
    const plus = /^\+\+\+ b\/(.+)$/m.exec(chunk);
    let path = plus?.[1]?.trim();
    if (!path || path === "/dev/null") {
      const git = /^diff --git a\/.+ b\/(.+)$/m.exec(chunk);
      path = git?.[1]?.trim();
    }
    if (path) map.set(path, chunk.replace(/\n+$/, "\n"));
  }
  return map;
}

/**
 * List the immediate children of `path` (default the checkout root) for a
 * host-native workspace, returning absolute paths the same way the VM path does
 * (so the UI can `basename` them). `.git` is hidden. Returns null when the
 * workspace has no host_path (caller falls back to the VM path).
 */
export async function localWorkspaceFiles(
  id: string,
  path?: string,
): Promise<{ path: string; files: string[] } | null> {
  const root = await getLocalWorkspaceDir(id);
  if (!root) return null;

  const target = path && path.trim() ? resolveInside(root, path) : root;
  const entries = await readdir(target, { withFileTypes: true }).catch(
    () => [],
  );
  const files = entries
    .filter((e) => e.name !== ".git")
    .map((e) => join(target, e.name) + (e.isDirectory() ? "/" : ""))
    .sort();

  return { path: target, files };
}

/**
 * Read a single file's text content from a host-native workspace. The path is
 * resolved INSIDE the checkout dir (path-traversal outside the workspace is
 * rejected). Accepts either an absolute path under the checkout or a
 * repo-relative path. Returns null when the workspace has no host_path.
 */
export async function localWorkspaceRead(
  id: string,
  path: string,
): Promise<{ path: string; content: string } | null> {
  const root = await getLocalWorkspaceDir(id);
  if (!root) return null;

  const abs = resolveInside(root, path);
  const content = await readFile(abs, "utf8");
  return { path: abs, content };
}

/**
 * Resolve `p` (absolute-under-root or repo-relative) to an absolute path that is
 * guaranteed to stay inside `root`. Throws on traversal outside the workspace.
 */
function resolveInside(root: string, p: string): string {
  const normRoot = normalize(root);
  const abs = p.startsWith("/") ? normalize(p) : normalize(join(normRoot, p));
  const rel = relative(normRoot, abs);
  if (
    rel === "" ||
    rel === "." ||
    (!rel.startsWith("..") && !rel.startsWith(sep + ".."))
  ) {
    return abs;
  }
  throw new Error(`Path '${p}' escapes the workspace root`);
}

/**
 * Destroy a host-native workspace: `rm -rf` its checkout directory and mark the
 * `v3_workspaces` row `destroyed`. Idempotent — a missing directory or an
 * already-destroyed row is fine. The row update always runs so the lifecycle is
 * recorded even if the rm fails.
 */
export async function destroyLocalWorkspace(id: string): Promise<void> {
  const db = getV3Db();
  const [row] = await db
    .select({
      hostPath: v3Schema.v3Workspaces.hostPath,
      repoUrl: v3Schema.v3Workspaces.repoUrl,
    })
    .from(v3Schema.v3Workspaces)
    .where(eq(v3Schema.v3Workspaces.id, id))
    .limit(1);

  const dir = row?.hostPath ?? `${WORKSPACE_ROOT}/${id}`;

  // Worktree mode: detach the worktree from its bare mirror BEFORE removing the
  // dir so the mirror's worktree registry stays clean (a plain rm leaves a stale
  // entry until the next prune). Best-effort — falls through to rm regardless.
  if (getWorkspaceIsolation() === "worktree" && row?.repoUrl) {
    const bare = bareMirrorDir(row.repoUrl);
    await git(["-C", bare, "worktree", "remove", "--force", dir]).catch(
      () => {},
    );
    await git(["-C", bare, "worktree", "prune"]).catch(() => {});
  }

  await rm(dir, { recursive: true, force: true }).catch(() => {});

  await db
    .update(v3Schema.v3Workspaces)
    .set({ state: "destroyed", destroyedAt: new Date() })
    .where(eq(v3Schema.v3Workspaces.id, id));
}

/**
 * Stage everything, commit, push the workspace branch, and optionally open a PR.
 *
 *  • `git add -A` then `git commit -m <message>` — a clean tree yields
 *    `{ committed: false }` (NOT an error: a node may legitimately produce no
 *    file change). The push still runs so an earlier commit can be published.
 *  • Push uses an EPHEMERAL `x-access-token` remote (DESIGN §13) built from the
 *    stored clean `repo_url`; the token never lands in `.git/config`.
 *  • When `createMr` is set, opens a PR via `gh pr create` (preferred) or, if
 *    `gh` is unavailable, the GitHub REST API with the token, and returns the
 *    real PR URL. A PR URL is returned ONLY when a real PR was opened.
 *
 * Fails LOUDLY: a git/gh failure throws with the (token-redacted) stderr — the
 * caller (commit node) must see the real error, never a silent swallow.
 */
export async function commitAndPush(
  opts: CommitAndPushOptions,
): Promise<CommitAndPushResult> {
  const db = getV3Db();
  const [row] = await db
    .select({
      id: v3Schema.v3Workspaces.id,
      hostPath: v3Schema.v3Workspaces.hostPath,
      repoUrl: v3Schema.v3Workspaces.repoUrl,
      branch: v3Schema.v3Workspaces.branch,
      state: v3Schema.v3Workspaces.state,
    })
    .from(v3Schema.v3Workspaces)
    .where(eq(v3Schema.v3Workspaces.id, opts.id))
    .limit(1);

  if (!row) {
    throw new Error(`commitAndPush: workspace '${opts.id}' not found`);
  }
  if (!row.hostPath) {
    throw new Error(
      `commitAndPush: workspace '${opts.id}' has no host_path (not a local workspace)`,
    );
  }
  if (row.state === "destroyed") {
    throw new Error(`commitAndPush: workspace '${opts.id}' is destroyed`);
  }

  const dir = row.hostPath;
  let branch =
    row.branch && row.branch.trim() !== ""
      ? row.branch.trim()
      : defaultRunBranch(opts.id);

  // Safety: never push delivery commits onto the PR base branch. A workspace
  // checked out directly on the base (e.g. "main") would otherwise push
  // straight to it and the PR-create step would 422 (head == base). When the
  // workspace branch collides with the requested base, retarget the push to a
  // distinct per-workspace feature branch so a real PR can open.
  const baseForGuard =
    opts.baseBranch && opts.baseBranch.trim() !== ""
      ? opts.baseBranch.trim()
      : null;
  if (baseForGuard && branch === baseForGuard) {
    branch = defaultRunBranch(opts.id);
  }
  const token = await resolveGithubToken();

  // ── Defense in depth: never commit MCP config / secret-bearing files ──────
  // The brain's `.mcp.json` carries a live A2A bearer. Even though it now lives
  // OUTSIDE the workspace, harden the commit path so a stray `.mcp.json` (or any
  // `*.mcp.json`) can never be swept into a commit, and refuse to commit any
  // staged file whose content looks like it carries a bearer token.
  await excludeMcpConfigs(dir);

  // ── Stage + commit ──────────────────────────────────────────────────────
  const added = await git(["add", "-A"], { cwd: dir });
  if (added.code !== 0) {
    throw new Error(
      `git add -A failed (exit ${added.code}): ` +
        redact(`${added.stdout}\n${added.stderr}`.trim(), token),
    );
  }

  // Belt-and-suspenders: even if a `.mcp.json` somehow got staged (e.g. it was
  // already tracked, so .git/info/exclude does not apply), unstage it.
  await unstageMcpConfigs(dir);

  // Refuse to commit anything that looks like it leaks a credential. Scans the
  // staged diff for bearer-token-shaped literals and aborts the whole commit.
  await assertNoStagedSecrets(dir, token);

  let committed = false;
  let sha: string | null = null;
  const status = await git(["status", "--porcelain"], { cwd: dir });
  // Only files actually STAGED for commit matter — a leftover unstaged/untracked
  // `.mcp.json` we just excluded must not block or get into the commit.
  const staged = await git(["diff", "--cached", "--name-only"], { cwd: dir });
  if (staged.stdout.trim() !== "") {
    const commitRes = await git(["commit", "-m", opts.message], { cwd: dir });
    if (commitRes.code !== 0) {
      throw new Error(
        `git commit failed (exit ${commitRes.code}): ` +
          redact(`${commitRes.stdout}\n${commitRes.stderr}`.trim(), token),
      );
    }
    committed = true;
    const head = await git(["rev-parse", "HEAD"], { cwd: dir });
    sha = head.code === 0 ? head.stdout.trim() : null;
  }
  void status; // status retained for diagnostics; commit decision uses staged set

  // ── Push ────────────────────────────────────────────────────────────────
  const remote = row.repoUrl?.trim();
  if (!remote) {
    throw new Error(
      `commitAndPush: workspace '${opts.id}' has no repo_url to push to`,
    );
  }
  const isHttps = /^https:\/\//.test(remote);
  if (isHttps && !token) {
    throw new Error(
      `commitAndPush: no GITHUB_TOKEN available to push '${branch}' to ${remote}. ` +
        `Register the secret (resolveSecret('GITHUB_TOKEN')) or set process.env.GITHUB_TOKEN.`,
    );
  }
  const pushUrl = withToken(remote, token);
  const pushRes = await git(["push", pushUrl, `HEAD:refs/heads/${branch}`], {
    cwd: dir,
  });
  if (pushRes.code !== 0) {
    throw new Error(
      `git push of '${branch}' failed (exit ${pushRes.code}): ` +
        redact(`${pushRes.stdout}\n${pushRes.stderr}`.trim(), token),
    );
  }

  const result: CommitAndPushResult = {
    committed,
    sha,
    pushed: true,
    branch,
  };

  // ── Optional: open a PR/MR ────────────────────────────────────────────────
  // A PR only makes sense for a github.com https remote. For a LOCAL remote (a
  // `file://` URL or a bare repo path the container can clone — the no-GitHub
  // deployment), the commit + push above already published the branch to the
  // local source; there is nothing to open a PR against, so skip it silently
  // instead of throwing. The branch lands in the local bare repo's refs.
  const isLocalRemote = !/^https:\/\//.test(remote) || !/github\.com/.test(remote);
  if (opts.createMr && isLocalRemote) {
    return result;
  }
  if (opts.createMr) {
    const prUrl = await openPr({
      dir,
      remote,
      branch,
      baseBranch: opts.baseBranch,
      title: opts.prTitle ?? opts.message,
      body: opts.prBody,
      token,
    });
    if (prUrl) result.prUrl = prUrl;
  }

  return result;
}

// ── PR / MR opener ───────────────────────────────────────────────────────────

/**
 * Open a PR for `branch`. Prefers `gh pr create` (reads GH_TOKEN from env);
 * falls back to the GitHub REST API when `gh` is unavailable but the remote is a
 * github.com https URL and a token is present. Returns the real PR URL, or
 * throws with the (token-redacted) stderr on failure.
 */
async function openPr(opts: {
  dir: string;
  remote: string;
  branch: string;
  baseBranch?: string;
  title: string;
  body?: string;
  token: string | null;
}): Promise<string | null> {
  const { dir, remote, branch, baseBranch, title, token } = opts;
  const body = opts.body ?? "Automated PR from an orchestrator run.";

  // Preferred path: gh CLI.
  if (await hasGh()) {
    const args = [
      "pr",
      "create",
      "--head",
      branch,
      "--title",
      title,
      "--body",
      body,
    ];
    if (baseBranch && baseBranch.trim() !== "") {
      args.push("--base", baseBranch.trim());
    }
    const env: Record<string, string> = token ? { GH_TOKEN: token } : {};
    const res = await gh(args, { cwd: dir, env });
    const out = `${res.stdout}\n${res.stderr}`;
    const urlMatch = /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(out);
    if (res.code === 0 && urlMatch) {
      return urlMatch[0];
    }
    // gh ran but failed — fall through to the API path only if it's worth trying.
    if (!token || !/github\.com/.test(remote)) {
      throw new Error(
        `gh pr create failed (exit ${res.code}): ` + redact(out.trim(), token),
      );
    }
  }

  // Fallback path: GitHub REST API (needs a github.com https remote + token).
  if (!token) {
    throw new Error(
      `openPr: cannot open a PR — gh is unavailable and no GITHUB_TOKEN is set`,
    );
  }
  const slug = parseGithubSlug(remote);
  if (!slug) {
    throw new Error(
      `openPr: cannot open a PR — '${remote}' is not a recognizable github.com remote`,
    );
  }
  const base =
    baseBranch && baseBranch.trim() !== "" ? baseBranch.trim() : "main";
  const apiUrl = `https://api.github.com/repos/${slug.owner}/${slug.repo}/pulls`;
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "orchestrator-v3",
    },
    body: JSON.stringify({ title, head: branch, base, body }),
  });
  const json = (await res.json().catch(() => null)) as {
    html_url?: string;
    message?: string;
  } | null;
  if (res.ok && json?.html_url) {
    return json.html_url;
  }
  throw new Error(
    `GitHub API PR create failed (HTTP ${res.status}): ${
      json?.message ?? "unknown error"
    }`,
  );
}

/** Parse `owner/repo` from a github.com https remote (with/without `.git`). */
function parseGithubSlug(
  remote: string,
): { owner: string; repo: string } | null {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote.trim());
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

// ── Secret-leak defense (DESIGN §13 hardening) ───────────────────────────────

/** Glob patterns for files that must NEVER be committed (carry live bearers). */
const MCP_CONFIG_PATTERNS = [".mcp.json", "*.mcp.json", "**/.mcp.json", "**/*.mcp.json"];

/**
 * Add the MCP-config patterns to `.git/info/exclude` so an untracked
 * `.mcp.json` is never staged by `git add -A`. Idempotent (skips lines already
 * present). `.git/info/exclude` is local-only — it never lands in the repo, so
 * we are not mutating committed `.gitignore`.
 */
async function excludeMcpConfigs(dir: string): Promise<void> {
  const excludePath = join(dir, ".git", "info", "exclude");
  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch {
    existing = "";
  }
  const have = new Set(existing.split("\n").map((l) => l.trim()));
  const toAdd = MCP_CONFIG_PATTERNS.filter((p) => !have.has(p));
  if (toAdd.length === 0) return;
  const next =
    (existing.endsWith("\n") || existing === "" ? existing : existing + "\n") +
    toAdd.join("\n") +
    "\n";
  await writeFile(excludePath, next, "utf8").catch(() => {});
}

/**
 * Unstage any `.mcp.json` / `*.mcp.json` that made it into the index (e.g. a
 * file that was already tracked, where `.git/info/exclude` does not apply).
 * `git reset` of those paths drops them from the commit without touching the
 * working tree.
 */
async function unstageMcpConfigs(dir: string): Promise<void> {
  const staged = await git(["diff", "--cached", "--name-only"], { cwd: dir });
  const offenders = staged.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((p) => p && /(^|\/)[^/]*\.mcp\.json$/.test(p));
  if (offenders.length === 0) return;
  await git(["reset", "-q", "--", ...offenders], { cwd: dir }).catch(() => {});
}

/**
 * Refuse to commit any staged file whose content looks like it carries a bearer
 * token (a credential leak). Scans the staged diff for `Authorization: Bearer`
 * headers and standalone JWT-shaped literals (three base64url segments). On a
 * hit it throws — the commit is aborted loudly so the leak never ships.
 */
async function assertNoStagedSecrets(
  dir: string,
  redactToken: string | null,
): Promise<void> {
  const diff = await git(["diff", "--cached", "--unified=0"], { cwd: dir });
  if (diff.code !== 0) return; // nothing staged / cannot diff — nothing to guard
  // Only inspect ADDED lines (the new content entering the commit).
  const added = diff.stdout
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  const bearerRe = /Authorization\s*["':]*\s*Bearer\s+[A-Za-z0-9._\-]+/i;
  const jwtRe = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;
  for (const line of added) {
    if (bearerRe.test(line) || jwtRe.test(line)) {
      // Identify the offending file for the error (best-effort).
      const names = await git(["diff", "--cached", "--name-only"], { cwd: dir });
      throw new Error(
        "commitAndPush: refusing to commit — staged changes contain a " +
          "bearer-token-shaped credential (possible secret leak). Files: " +
          redact(names.stdout.trim().replace(/\n/g, ", "), redactToken),
      );
    }
  }
}

// ── Misc ─────────────────────────────────────────────────────────────────────

/** True when `dir` exists and is a directory (used by callers/tests). */
export async function workspaceDirExists(dir: string): Promise<boolean> {
  try {
    const s = await stat(dir);
    return s.isDirectory();
  } catch {
    return false;
  }
}
