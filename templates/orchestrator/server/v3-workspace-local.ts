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
import { createHash } from "node:crypto";
import {
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { join, normalize, relative, sep } from "node:path";

import { eq } from "drizzle-orm";

import {
  getV3Db,
  v3Schema,
  LOCAL_DEFAULT_OWNER,
  getDbExec,
} from "./db/index.js";
import {
  WorkspaceNotReadyError,
  DiffBaseUnresolvableError,
  assertDependenciesWarm,
  runTestCmdSmoke,
  type DepWarmReport,
  type SmokeReport,
} from "./v3-workspace-provision.js";

export { WorkspaceNotReadyError, DiffBaseUnresolvableError };

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

/**
 * Bound for freshness-critical git calls (`refreshMirror`), configurable via
 * `GIT_TIMEOUT_MS` so a network-unreachable remote fails fast and bounded
 * (T-F1-16: a tiny value here means a test doesn't have to wait out the OS's
 * own TCP connect timeout to prove the bound is enforced). Falls back to the
 * generous clone/push {@link GIT_TIMEOUT_MS} when unset.
 */
export function resolveGitTimeoutMs(): number {
  const raw = Number(process.env.GIT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : GIT_TIMEOUT_MS;
}

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
  /**
   * Explicit push target branch, overriding the workspace's recorded
   * `v3_workspaces.branch`. Omit to push to the workspace's own branch (the
   * common case — a workspace normally already owns its run branch).
   */
  branch?: string;
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
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<GitResult> {
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
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
      reject(new Error(`git ${args[0] ?? ""} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

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
    let resolvedBaseRef: string;
    if (getWorkspaceIsolation() === "worktree") {
      resolvedBaseRef = await provisionWorktree({
        repoUrl,
        dir,
        branch,
        token,
        baseRef: opts.baseRef?.trim() || undefined,
      });
    } else {
      resolvedBaseRef = await provisionClone({
        repoUrl,
        dir,
        branch,
        token,
        baseRef: opts.baseRef?.trim() || undefined,
      });
    }

    // ── Readiness assertion (W1→W2→W3, DESIGN §7) ─────────────────────────
    // Only after ALL three invariants pass does the row become ready — a
    // WorkspaceNotReadyError thrown here is caught below and marks the row
    // `failed` (infra condition, not a provisioning error) instead of `ready`.
    const mirrorDir =
      getWorkspaceIsolation() === "worktree" ? bareMirrorDir(repoUrl) : null;
    const ready = await assertWorkspaceReady(dir, mirrorDir, {
      targetBranch: resolvedBaseRef,
    });

    await db
      .update(v3Schema.v3Workspaces)
      .set({
        state: "ready",
        baseSha: ready.baseSha,
        readyAt: new Date(ready.readyAt),
        readyReport: ready.report as unknown,
        tags: { base_ref: resolvedBaseRef } as Record<string, string>,
      })
      .where(eq(v3Schema.v3Workspaces.id, id));

    return { id, dir, branch };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const isReadinessFailure = err instanceof WorkspaceNotReadyError;
    // Mark the row `failed` for a readiness-assertion miss (infra, W1-W3 —
    // never counted as an agent failure) or `error` for anything else (a
    // genuine provisioning failure — clone/worktree-add/config). Clean up the
    // partial checkout either way (best-effort). In worktree mode also detach
    // the half-added worktree from the mirror.
    await db
      .update(v3Schema.v3Workspaces)
      .set(
        isReadinessFailure
          ? { state: "failed", readyReport: { error: message } as unknown }
          : { state: "error" },
      )
      .where(eq(v3Schema.v3Workspaces.id, id))
      .catch(() => {});
    if (getWorkspaceIsolation() === "worktree") {
      const bare = bareMirrorDir(repoUrl);
      await git(["-C", bare, "worktree", "remove", "--force", dir]).catch(
        () => {},
      );
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    if (isReadinessFailure) {
      // Preserve the WorkspaceNotReadyError identity (stage/detail/errorClass
      // ='infra') — callers (createWorkspace's caller, the dispatcher) must be
      // able to `instanceof` this, not just read a generic wrapped message.
      throw err;
    }
    throw new Error(`createLocalWorkspace failed for ${repoUrl}: ${message}`);
  }
}

/**
 * Full `git clone` per workspace (the original "clone" strategy). Clones into
 * `dir`, resets `origin` to the clean URL (token never persisted), sets the bot
 * identity, and cuts + checks out `branch`. Returns the resolved target-branch
 * name (the branch W1/W4 track going forward) — `opts.baseRef` when explicit,
 * else whatever the clone's default checkout resolved to.
 */
async function provisionClone(opts: {
  repoUrl: string;
  dir: string;
  branch: string;
  token: string | null;
  baseRef?: string;
}): Promise<string> {
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

  // Resolve + capture the target branch BEFORE cutting the run branch off it
  // (checkout -B below moves HEAD to a NEW branch).
  let resolvedBranchName: string;
  if (opts.baseRef && opts.baseRef.trim()) {
    resolvedBranchName = opts.baseRef.trim();
    const co = await git(["checkout", resolvedBranchName], { cwd: dir });
    if (co.code !== 0) {
      throw new Error(
        `git checkout ${resolvedBranchName} (base) failed (exit ${co.code}): ` +
          redact(`${co.stdout}\n${co.stderr}`.trim(), token),
      );
    }
  } else {
    const head = await git(["symbolic-ref", "--short", "HEAD"], {
      cwd: dir,
    }).catch(() => null);
    resolvedBranchName =
      head && head.code === 0 && head.stdout.trim()
        ? head.stdout.trim()
        : "HEAD";
  }

  const checkout = await git(["checkout", "-B", branch], { cwd: dir });
  if (checkout.code !== 0) {
    throw new Error(
      `git checkout -B ${branch} failed (exit ${checkout.code}): ` +
        redact(`${checkout.stdout}\n${checkout.stderr}`.trim(), token),
    );
  }
  return resolvedBranchName;
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
 *
 * Returns the resolved target-branch NAME (never `FETCH_HEAD` — that's only
 * valid as a `worktree add` ref, not a stable name to re-resolve later): the
 * caller's explicit `baseRef` when given, else whatever
 * {@link resolveBareBaseRef} found (e.g. `main`/`master`, or the literal
 * `HEAD` sentinel when nothing is resolvable — W1/W4 then fail loud rather
 * than silently tracking nothing).
 */
async function provisionWorktree(opts: {
  repoUrl: string;
  dir: string;
  branch: string;
  token: string | null;
  /** Explicit base ref to cut the run branch from (e.g. the project branch). */
  baseRef?: string;
}): Promise<string> {
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
  let resolvedBranchName: string;
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
    if (fetched.code === 0) {
      baseRef = "FETCH_HEAD";
    } else {
      // Fetch failed (e.g. branch not on remote) — fall back gracefully to
      // whatever default branch the mirror has (refs/remotes/origin/* —
      // see resolveBareBaseRef/ensureBareMirror's doc comments).
      const fallback = await resolveBareBaseRef(bare);
      baseRef =
        fallback === "HEAD" ? "HEAD" : `refs/remotes/origin/${fallback}`;
    }
    // The caller explicitly asked to track `wanted` — track it regardless of
    // which ref `worktree add` actually cut from, so a genuinely-missing
    // upstream branch surfaces as an explicit W1/W4 failure later rather than
    // silently tracking a different branch.
    resolvedBranchName = wanted;
  } else {
    const resolved = await resolveBareBaseRef(bare);
    resolvedBranchName = resolved;
    // resolveBareBaseRef returns a BARE name (e.g. "main") tracked upstream
    // under refs/remotes/origin/* (never refs/heads/* — that namespace is
    // reserved for each workspace's own branch, added by `worktree add`
    // below); "HEAD" is the sentinel for "nothing resolvable at all".
    baseRef = resolved === "HEAD" ? "HEAD" : `refs/remotes/origin/${resolved}`;
  }

  // Board #87 — reusing the base branch's own name as the NEW work `branch`
  // (e.g. passing `branch: "main"` when "main" is what you meant as the base)
  // collides under this shared-bare-mirror model: every workspace for the
  // same repo shares ONE `refs/heads/*` namespace, so a repeat/concurrent
  // create for the same base fails with a raw git worktree/fetch error
  // ("already used by worktree" / "refusing to fetch into branch ... checked
  // out at ...") that gives the caller no idea what to change. Fail fast with
  // an actionable message instead — BEFORE the git call, and even on the
  // first-ever create for a repo (deterministic, not just a race).
  if (branch === resolvedBranchName) {
    throw new Error(
      `workspaceCreate: branch ('${branch}') must not equal the base branch it is being cut from ('${resolvedBranchName}'). ` +
        `'branch' names the NEW work branch to check out (a fresh branch cut FROM the base) — it must differ from the base. ` +
        `Pass the base via 'baseRef' (e.g. baseRef: '${resolvedBranchName}') and either omit 'branch' (defaults to a unique ` +
        `per-run name) or choose a distinct branch name.`,
    );
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

  return resolvedBranchName;
}

/**
 * Ensure a bare mirror exists at `bare` for `repoUrl`. Creates it with
 * `git init --bare` + `remote add origin` on first use, then (both first use
 * AND every later refresh) fetches upstream's branches into
 * `refs/remotes/origin/*` — auth URL one-shot, origin reset to the clean URL
 * after. Best-effort on refresh (a fetch failure on an already-usable mirror
 * is non-fatal — we still have the objects from last time); the FIRST fetch
 * on a brand-new mirror is NOT best-effort — a mirror with no upstream data
 * at all must not be silently treated as usable.
 *
 * IMPORTANT — never fetch upstream into `refs/heads/*`: this bare mirror is
 * SHARED across every workspace for the same repo, and each workspace's own
 * (not-yet-pushed) run branch lives under `refs/heads/<branch>` (created by
 * `git worktree add -B`, below). An earlier version of this function fetched
 * upstream with `--prune … +refs/heads/*:refs/heads/*`, which mirrors the
 * remote's branch set EXACTLY — including pruning any local `refs/heads/*`
 * ref absent from the remote. Because a workspace's run branch is, by
 * definition, absent from the remote until it's pushed, the very next
 * refresh (triggered by ANY other workspace being created/refreshed for the
 * same repo, or by a W4 diff/runSummary poll — see `refreshMirror`) deleted
 * it out from under an already-`ready`, already-committed-to workspace,
 * silently reverting its HEAD to unborn (`git log` → "does not have any
 * commits yet") while leaving the checkout's files/index untouched — the
 * unborn-HEAD writeback-drain incident (108+ failed retries). Keeping
 * upstream state in `refs/remotes/origin/*` and workspace branches in
 * `refs/heads/*` disjoint makes `--prune` safe again: it can only ever prune
 * a stale `refs/remotes/origin/*` entry.
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
    (
      await git(["-C", bare, "rev-parse", "--is-bare-repository"]).catch(
        () => ({
          code: 1,
          stdout: "",
          stderr: "",
        }),
      )
    ).stdout.trim() === "true";

  if (!isRepo) {
    const init = await git(["init", "--bare", bare]);
    if (init.code !== 0) {
      await rm(bare, { recursive: true, force: true }).catch(() => {});
      throw new Error(
        `git init --bare failed (exit ${init.code}): ` +
          redact(`${init.stdout}\n${init.stderr}`.trim(), token),
      );
    }
    const cloneUrl = withToken(repoUrl, token);
    await git(["-C", bare, "remote", "add", "origin", cloneUrl]);
  }

  // First fetch (brand-new mirror) AND every later refresh: mirror upstream's
  // branches into refs/remotes/origin/* — never refs/heads/* (see above).
  const fetchUrl = withToken(repoUrl, token);
  const fetched = await git([
    "-C",
    bare,
    "fetch",
    "--prune",
    fetchUrl,
    "+refs/heads/*:refs/remotes/origin/*",
  ]);
  if (!isRepo && fetched.code !== 0) {
    // A brand-new mirror with no upstream data at all is not a usable
    // mirror — never best-effort this one.
    await rm(bare, { recursive: true, force: true }).catch(() => {});
    throw new Error(
      `git fetch (initial mirror populate) failed (exit ${fetched.code}): ` +
        redact(`${fetched.stdout}\n${fetched.stderr}`.trim(), token),
    );
  }
  // Make refs/remotes/origin/HEAD resolvable so resolveBareBaseRef can find
  // the default branch. Best-effort on refresh (existing mirror still usable
  // even if this one auxiliary call fails).
  await git(["-C", bare, "remote", "set-head", "origin", "-a"]).catch(() => {});
  // Drop the token from the mirror's persisted remote (never leaves it in
  // .git/config beyond this function's own auth fetch above).
  await git(["-C", bare, "remote", "set-url", "origin", repoUrl.trim()]).catch(
    () => {},
  );
}

/**
 * Resolve the base ref for a new worktree branch from the bare mirror. Reads
 * upstream's default branch from `refs/remotes/origin/HEAD` (set by
 * `ensureBareMirror`'s `remote set-head -a`) — NEVER the bare repo's own
 * top-level `HEAD` or a local `refs/heads/*` ref, both of which are either
 * meaningless (a mirror created via `git init --bare` has no real top-level
 * HEAD target) or reserved for workspace-owned branches (see
 * `ensureBareMirror`'s doc comment) after the refs/remotes/origin/* rework.
 * Returns a BARE branch name (e.g. `"main"`, never `"origin/main"`) — this is
 * the external contract every caller (tags.base_ref, W1/W4 target-branch
 * tracking) already depends on.
 */
async function resolveBareBaseRef(bare: string): Promise<string> {
  const head = await git(
    ["-C", bare, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    {},
  ).catch(() => null);
  if (head && head.code === 0 && head.stdout.trim()) {
    const short = head.stdout.trim().replace(/^origin\//, "");
    if (short) return short;
  }
  for (const ref of ["main", "master"]) {
    const ok = await git([
      "-C",
      bare,
      "rev-parse",
      "--verify",
      `refs/remotes/origin/${ref}`,
    ]).catch(() => null);
    if (ok && ok.code === 0) return ref;
  }
  // Last resort sentinel — nothing resolvable upstream at all.
  return "HEAD";
}

// ── W1/W4: readiness + dynamic diff-base resolution ─────────────────────────

/**
 * Refresh the shared bare mirror from its real upstream (`git fetch --prune`,
 * mapping into `refs/remotes/origin/*` — matches {@link ensureBareMirror}'s
 * mirroring convention; NEVER `refs/heads/*`, which this same mirror also
 * uses to store each workspace's own not-yet-pushed run branch — see that
 * function's doc comment for why mixing the two namespaces is the
 * unborn-HEAD incident's root cause). Bounded by {@link resolveGitTimeoutMs}
 * (default 180s, overridable via `GIT_TIMEOUT_MS` for a fast-fail
 * test/injection — T-F1-16). Called AT CALL TIME by both
 * {@link assertWorkspaceReady} (W1) and {@link resolveDiffBase} (W4) — never
 * a cached/static freshness check. Throws a plain `Error` on failure (timeout
 * or non-zero exit); callers reclassify it (`WorkspaceNotReadyError` for W1,
 * `DiffBaseUnresolvableError` for W4) in their own context.
 */
export async function refreshMirror(mirrorDir: string): Promise<void> {
  const timeoutMs = resolveGitTimeoutMs();
  let res: GitResult;
  try {
    res = await git(
      ["fetch", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*"],
      {
        cwd: mirrorDir,
        timeoutMs,
      },
    );
  } catch (err: unknown) {
    throw new Error(
      `refreshMirror: git fetch failed for '${mirrorDir}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (res.code !== 0) {
    throw new Error(
      `refreshMirror: git fetch --prune failed (exit ${res.code}) for '${mirrorDir}': ` +
        (res.stderr.trim() || res.stdout.trim()),
    );
  }
}

/**
 * Fetch `targetBranch` from `source` (a bare-mirror path, in worktree
 * isolation, or the literal remote name `"origin"` in clone isolation) INTO
 * `dir`'s own `refs/remotes/origin/<targetBranch>` — a uniform ref location
 * regardless of isolation mode, so {@link resolveDiffBase} /
 * {@link assertWorkspaceReady} don't need mode-specific merge-base logic.
 * Throws `DiffBaseUnresolvableError` when the branch isn't fetchable (the
 * W4/T-F1-02 "target branch doesn't exist" case).
 *
 * Worktree isolation's `source` is the shared bare-mirror PATH, whose own
 * upstream copy of `targetBranch` lives under `refs/remotes/origin/<name>`
 * (never `refs/heads/<name>` — {@link ensureBareMirror}'s doc comment), so
 * the SOURCE-side ref must name that path explicitly; a bare short name like
 * `"main"` would resolve against the mirror's OWN `refs/heads/main` /
 * `refs/remotes/main` (unrelated remote literally named "main") per git's
 * short-ref disambiguation order, never `refs/remotes/origin/main`. Clone
 * isolation's `source==="origin"` is a real remote name (the workspace's own
 * normal, non-bare clone), where the plain branch name already resolves
 * exactly as the remote advertises it — no prefix needed there.
 */
async function fetchTargetIntoOriginRef(
  dir: string,
  source: string,
  targetBranch: string,
): Promise<void> {
  const sourceRef =
    source === "origin" ? targetBranch : `refs/remotes/origin/${targetBranch}`;
  let res: GitResult;
  try {
    // `+` (force) — this ref mirrors the target branch TIP; a rewritten
    // upstream (force push) must update it rather than fail the local
    // fast-forward check and misreport "branch unfetchable".
    res = await git(
      ["fetch", source, `+${sourceRef}:refs/remotes/origin/${targetBranch}`],
      { cwd: dir },
    );
  } catch (err: unknown) {
    throw new DiffBaseUnresolvableError(
      dir,
      targetBranch,
      `fetch from '${source}' failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.code !== 0) {
    throw new DiffBaseUnresolvableError(
      dir,
      targetBranch,
      `git fetch ${source} ${targetBranch} failed (exit ${res.code}): ` +
        (res.stderr.trim() || res.stdout.trim()),
    );
  }
}

/**
 * W4 rewrite (SDLC-059, v3-workspace-local.ts:716 in the original bug
 * report) — dynamically resolve the divergence base AT CALL TIME. Refreshes
 * the shared bare mirror (`mirrorDir`, worktree isolation) or fetches
 * directly from `origin` (`mirrorDir === null`, clone isolation), then
 * computes `git merge-base` against HEAD. ANY failure (branch missing
 * upstream, no common ancestor, network/timeout) throws
 * `DiffBaseUnresolvableError` — this NEVER degrades through
 * `origin/main` → `origin/master` → `HEAD~1` → the empty tree (the B4
 * false-diff root cause).
 */
export async function resolveDiffBase(
  dir: string,
  mirrorDir: string | null,
  targetBranch: string,
): Promise<{ base: string; baseSource: string }> {
  if (mirrorDir) {
    try {
      await refreshMirror(mirrorDir);
    } catch (err: unknown) {
      throw new DiffBaseUnresolvableError(
        dir,
        targetBranch,
        `refreshMirror failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const source = mirrorDir ?? "origin";
  await fetchTargetIntoOriginRef(dir, source, targetBranch);

  let mb: GitResult;
  try {
    mb = await git(
      ["merge-base", `refs/remotes/origin/${targetBranch}`, "HEAD"],
      {
        cwd: dir,
      },
    );
  } catch (err: unknown) {
    throw new DiffBaseUnresolvableError(
      dir,
      targetBranch,
      `merge-base failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (mb.code !== 0 || !mb.stdout.trim()) {
    throw new DiffBaseUnresolvableError(
      dir,
      targetBranch,
      mb.stderr.trim() || "no common ancestor with the target branch",
    );
  }

  return {
    base: mb.stdout.trim(),
    baseSource: `merge-base(origin/${targetBranch}, HEAD)`,
  };
}

/**
 * Resolve the branch this workspace tracks for W1 (freshness) and W4 (diff
 * base) purposes. Prefers the `base_ref` tag persisted by
 * {@link createLocalWorkspace} at creation time (via
 * {@link provisionWorktree}/{@link provisionClone}'s resolved branch name);
 * falls back to a fresh {@link resolveBareBaseRef} lookup for legacy rows
 * created before that tag existed. Throws `DiffBaseUnresolvableError` when
 * neither source resolves a real branch name.
 */
async function resolveWorkspaceTargetBranch(row: {
  repoUrl: string | null;
  tags: unknown;
}): Promise<string> {
  const tags =
    row.tags && typeof row.tags === "object"
      ? (row.tags as Record<string, unknown>)
      : {};
  const tagged = typeof tags.base_ref === "string" ? tags.base_ref.trim() : "";
  if (tagged) return tagged;

  if (!row.repoUrl) {
    throw new DiffBaseUnresolvableError(
      "(workspace)",
      "(untracked)",
      "workspace has no repo_url and no tracked base_ref tag",
    );
  }
  const bare = bareMirrorDir(row.repoUrl);
  const resolved = await resolveBareBaseRef(bare).catch(() => "HEAD");
  if (!resolved || resolved === "HEAD") {
    throw new DiffBaseUnresolvableError(
      bare,
      "(unresolved)",
      "no default branch resolvable from the mirror's origin/HEAD, and no tracked base_ref tag",
    );
  }
  return resolved;
}

/**
 * W1 — baseline freshness: after (re-)fetching, the workspace's HEAD must sit
 * EXACTLY at the target branch's current tip (merge-base distance 0). A
 * freshly-provisioned worktree/clone that's fallen behind (the mirror
 * advanced between provisioning and this assertion) is fast-forwarded with a
 * `git reset --hard` and re-checked; a workspace that's still behind after
 * that reset — or whose target branch can't be resolved/fetched at all —
 * throws `WorkspaceNotReadyError('W1', …)`.
 *
 * SCOPE (do not over-read this): this only runs once, from
 * {@link createLocalWorkspace}, at workspace creation. F1 carries no
 * delivery-time freshness gate — there is no re-assertion of merge-base==tip
 * before a run's work is committed/pushed. What F1 DOES guarantee for the
 * lifetime of a run is that {@link resolveDiffBase} (W4) always computes a
 * correct divergence base at call time, or fails loudly (never a silent
 * guessed/stale diff). Across a long-lived run, while the target branch keeps
 * advancing past this baseline, there is a bounded window (B2) where the
 * workspace's cut point drifts behind the target's current tip; the final
 * merge-base==tip assertion immediately before landing is `merge-pr`'s
 * brain/DAG responsibility, not this module's. A `workspace.stale` event for
 * that in-flight drift and an explicit delivery-time freshness gate are open
 * F1 follow-ups (T-F1-12 — see the deviations note in the implementation
 * report), not something this function already covers.
 */
export async function assertW1BaselineFresh(
  dir: string,
  mirrorDir: string | null,
  targetBranch: string,
): Promise<{ baseSha: string; resetPerformed: boolean; detail: string }> {
  if (mirrorDir) {
    try {
      await refreshMirror(mirrorDir);
    } catch (err: unknown) {
      throw new WorkspaceNotReadyError(
        "W1",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  const source = mirrorDir ?? "origin";
  try {
    await fetchTargetIntoOriginRef(dir, source, targetBranch);
  } catch (err: unknown) {
    throw new WorkspaceNotReadyError(
      "W1",
      err instanceof Error ? err.message : String(err),
    );
  }

  const targetRef = `refs/remotes/origin/${targetBranch}`;
  const targetTip = await git(["rev-parse", targetRef], { cwd: dir });
  if (targetTip.code !== 0 || !targetTip.stdout.trim()) {
    throw new WorkspaceNotReadyError(
      "W1",
      `cannot resolve '${targetRef}': ${targetTip.stderr.trim() || targetTip.stdout.trim()}`,
    );
  }
  const tip = targetTip.stdout.trim();

  const isFresh = async (): Promise<boolean> => {
    const mb = await git(["merge-base", targetRef, "HEAD"], { cwd: dir });
    return mb.code === 0 && mb.stdout.trim() === tip;
  };

  if (await isFresh()) {
    return {
      baseSha: tip,
      resetPerformed: false,
      detail: `merge-base distance 0 against ${targetBranch}@${tip.slice(0, 12)}`,
    };
  }

  // Stale — the workspace was cut before the target branch advanced (or the
  // fetch above just pulled a newer tip). Fast-forward the fresh checkout —
  // safe because no work has happened on it yet (assertWorkspaceReady runs
  // immediately after provisioning, before any commits land on the run branch).
  const reset = await git(["reset", "--hard", targetRef], { cwd: dir });
  if (reset.code !== 0) {
    throw new WorkspaceNotReadyError(
      "W1",
      `git reset --hard ${targetRef} failed (exit ${reset.code}): ` +
        (reset.stderr.trim() || reset.stdout.trim()),
    );
  }
  if (!(await isFresh())) {
    throw new WorkspaceNotReadyError(
      "W1",
      `merge-base distance still nonzero after reset --hard ${targetRef}`,
    );
  }
  return {
    baseSha: tip,
    resetPerformed: true,
    detail: `stale at creation — reset --hard ${targetBranch}@${tip.slice(0, 12)} to reach merge-base distance 0`,
  };
}

/** Aggregate report from the W1→W2→W3 readiness sequence (persisted as `ready_report`). */
export interface ReadyReport {
  w1: {
    ok: true;
    baseSha: string;
    targetBranch: string;
    resetPerformed: boolean;
    detail: string;
  };
  w2: DepWarmReport;
  w3: SmokeReport;
}

export interface AssertWorkspaceReadyOptions {
  /** The branch W1 freshness + W4 diff-base track for this workspace. */
  targetBranch: string;
  pnpmStoreDir?: string;
  /** Project-level `test_cmd_smoke` override (tracker project settings). */
  testCmdSmoke?: string | null;
}

/**
 * The full W1→W2→W3 readiness assertion sequence (02-workflows.md §7). Runs
 * IN ORDER — a W1 failure never reaches W2/W3. Only when all three pass does
 * the caller (createLocalWorkspace) get a `readyAt`/`baseSha`/`report` to
 * persist; any stage's `WorkspaceNotReadyError` propagates uncaught.
 */
export async function assertWorkspaceReady(
  dir: string,
  mirrorDir: string | null,
  opts: AssertWorkspaceReadyOptions,
): Promise<{ baseSha: string; readyAt: string; report: ReadyReport }> {
  const w1 = await assertW1BaselineFresh(dir, mirrorDir, opts.targetBranch);
  const w2 = await assertDependenciesWarm(dir, {
    pnpmStoreDir: opts.pnpmStoreDir,
  });
  const w3 = await runTestCmdSmoke(dir, { command: opts.testCmdSmoke });

  const readyAt = new Date().toISOString();
  return {
    baseSha: w1.baseSha,
    readyAt,
    report: {
      w1: {
        ok: true,
        baseSha: w1.baseSha,
        targetBranch: opts.targetBranch,
        resetPerformed: w1.resetPerformed,
        detail: w1.detail,
      },
      w2,
      w3,
    },
  };
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

/** The fields {@link localWorkspaceDiff} needs to resolve W4's target branch. */
interface LocalWorkspaceRow {
  hostPath: string | null;
  state: string;
  repoUrl: string | null;
  tags: unknown;
}

async function getLocalWorkspaceRow(
  id: string,
): Promise<LocalWorkspaceRow | null> {
  const db = getV3Db();
  const [row] = await db
    .select({
      hostPath: v3Schema.v3Workspaces.hostPath,
      state: v3Schema.v3Workspaces.state,
      repoUrl: v3Schema.v3Workspaces.repoUrl,
      tags: v3Schema.v3Workspaces.tags,
    })
    .from(v3Schema.v3Workspaces)
    .where(eq(v3Schema.v3Workspaces.id, id))
    .limit(1);

  if (!row || !row.hostPath || row.state === "destroyed") {
    return null;
  }
  return row;
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
  /** The base ref the diff was taken against (a merge-base sha, or the resolved `against` commit). */
  base: string;
  /** Where `base` came from: `"explicit"` (caller passed `against`) or `merge-base(origin/<branch>, HEAD)` (W4). */
  baseSource: string;
}

/**
 * Compute the diff for a host-native workspace.
 *
 * The run branch's work is typically already COMMITTED (a commit node ran
 * `git commit`), so a bare `git diff HEAD` (working tree vs HEAD) is empty.
 * To surface BOTH committed branch work AND any uncommitted edits, we diff
 * against the divergence point from the workspace's tracked target branch:
 *
 *   base = git merge-base origin/<target> HEAD   (W4 — resolved AT CALL TIME, never cached)
 *   git diff <base>                              (two-dot: working tree vs base)
 *
 * Two-dot (not three-dot) is deliberate: it includes uncommitted working-tree
 * changes too, so a workspace mid-edit still shows its diff. When `against` is
 * supplied it overrides the computed base — resolved directly via
 * `git rev-parse` with `baseSource: "explicit"`, WITHOUT refreshing the
 * mirror or computing a merge-base (T-F1-15: an explicit comparison ref for
 * review-diff scenarios is trusted as-is). A workspace with no host_path
 * returns null (caller falls back to the VM path). Throws
 * `DiffBaseUnresolvableError` when the base cannot be resolved (W4) — the
 * caller (the `workspaceDiff` action, `runSummary`'s diff stats) must catch
 * this and return `{ error: "diff-base-unresolvable", detail }`, never a diff
 * computed against a guessed/stale base.
 */
export async function localWorkspaceDiff(
  id: string,
  against?: string,
): Promise<LocalDiffResult | null> {
  const row = await getLocalWorkspaceRow(id);
  if (!row || !row.hostPath) return null;
  const dir = row.hostPath;

  let base: string;
  let baseSource: string;
  if (against && against.trim()) {
    const wanted = against.trim();
    const resolved = await git(["rev-parse", wanted], { cwd: dir });
    if (resolved.code !== 0 || !resolved.stdout.trim()) {
      throw new DiffBaseUnresolvableError(
        dir,
        wanted,
        resolved.stderr.trim() || `'${wanted}' does not resolve to a commit`,
      );
    }
    base = resolved.stdout.trim();
    baseSource = "explicit";
  } else {
    const targetBranch = await resolveWorkspaceTargetBranch(row);
    const mirrorDir =
      getWorkspaceIsolation() === "worktree" && row.repoUrl
        ? bareMirrorDir(row.repoUrl)
        : null;
    const resolved = await resolveDiffBase(dir, mirrorDir, targetBranch);
    base = resolved.base;
    baseSource = resolved.baseSource;
  }

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

  return { diff: full.stdout, files, base, baseSource };
}

/** Aggregate diff stats for a workspace — no patch text (light "diff 统计" payload for run summaries). */
export interface LocalDiffStats {
  base: string;
  baseSource: string;
  filesChanged: number;
  additions: number;
  deletions: number;
}

/**
 * Same base-resolution contract as {@link localWorkspaceDiff} (W4 — dynamic,
 * throws `DiffBaseUnresolvableError` on failure), but returns aggregate
 * counts instead of full patch text. Used by `runSummary`'s diff stats (the
 * SECOND call site W4 must cover per T-F1-11 — `workspaceDiff` is the first).
 */
export async function localWorkspaceDiffStats(
  id: string,
  against?: string,
): Promise<LocalDiffStats | null> {
  const result = await localWorkspaceDiff(id, against);
  if (!result) return null;
  let additions = 0;
  let deletions = 0;
  for (const f of result.files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return {
    base: result.base,
    baseSource: result.baseSource,
    filesChanged: result.files.length,
    additions,
    deletions,
  };
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
 * Detect an unborn HEAD (`git rev-parse --verify HEAD` fails — no commit
 * exists on the current branch yet, e.g. `git log` reporting "does not have
 * any commits yet") and self-heal it from `baseSha` (the workspace's OWN
 * recorded readiness baseline, `v3_workspaces.base_sha`) before any commit
 * attempt. Uses `git update-ref refs/heads/<branch> <baseSha>` — a low-level
 * ref write that touches ONLY the ref, never the index or working tree — so
 * whatever is already staged/edited in the checkout is preserved exactly.
 * No-op when HEAD already resolves. Throws when unborn AND there's no
 * `baseSha` to heal from, or the current branch name can't be read, or the
 * ref update itself fails — never silently proceeds to commit a disconnected
 * root commit onto an empty history.
 */
async function ensureBranchNotUnborn(
  dir: string,
  baseSha: string | null,
): Promise<void> {
  const healthy = await git(["rev-parse", "--verify", "-q", "HEAD"], {
    cwd: dir,
  });
  if (healthy.code === 0) return;

  const branchRes = await git(["symbolic-ref", "--short", "HEAD"], {
    cwd: dir,
  });
  const branchName = branchRes.stdout.trim();
  if (branchRes.code !== 0 || !branchName) {
    throw new Error(
      `commitAndPush: workspace at '${dir}' has an unborn HEAD and its current branch name could not be read (${branchRes.stderr.trim() || branchRes.stdout.trim()})`,
    );
  }
  if (!baseSha || !baseSha.trim()) {
    throw new Error(
      `commitAndPush: workspace at '${dir}' has an unborn HEAD (branch '${branchName}') and no recorded base_sha to self-heal from — refusing to commit a disconnected root commit`,
    );
  }
  const repaired = await git(
    ["update-ref", `refs/heads/${branchName}`, baseSha.trim()],
    { cwd: dir },
  );
  if (repaired.code !== 0) {
    throw new Error(
      `commitAndPush: self-heal of unborn HEAD (branch '${branchName}' -> ${baseSha.trim()}) failed (exit ${repaired.code}): ` +
        (repaired.stderr.trim() || repaired.stdout.trim()),
    );
  }
  const reverified = await git(["rev-parse", "--verify", "-q", "HEAD"], {
    cwd: dir,
  });
  if (reverified.code !== 0) {
    throw new Error(
      `commitAndPush: workspace at '${dir}' still has an unborn HEAD after self-heal to ${baseSha.trim()}`,
    );
  }
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
      baseSha: v3Schema.v3Workspaces.baseSha,
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
    opts.branch && opts.branch.trim() !== ""
      ? opts.branch.trim()
      : row.branch && row.branch.trim() !== ""
        ? row.branch.trim()
        : defaultRunBranch(opts.id);

  // Detection/self-heal safety net (b) for the unborn-HEAD incident: even
  // with the ensureBareMirror/refreshMirror fix (prevention (a) — never
  // prune a workspace's own refs/heads/<branch> again), a workspace HEAD
  // could in principle still end up unborn (an older mirror created before
  // the fix, a manual ref delete, …). Never silently `git commit` onto that
  // — the resulting root commit would carry the ENTIRE checkout as "added"
  // (a false diff of the whole repo, not just this run's real change) — the
  // exact class of failure W4's DiffBaseUnresolvableError exists to prevent
  // elsewhere. Recreate the branch ref from the workspace's own recorded
  // `base_sha` (a plain `update-ref`, which touches ONLY the ref — never the
  // index/working tree, so any already-staged/uncommitted work survives) and
  // proceed; fail loud if there is no recorded base to heal from.
  await ensureBranchNotUnborn(dir, row.baseSha);

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
  const isLocalRemote =
    !/^https:\/\//.test(remote) || !/github\.com/.test(remote);
  if (opts.createMr && isLocalRemote) {
    await recordLastPush(opts.id, result);
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

  await recordLastPush(opts.id, result);
  return result;
}

/**
 * Durably record a REAL, verified push outcome on the workspace row itself —
 * see v3-schema.ts's v3Workspaces docblock for why this exists. Called ONLY
 * after `git push` has actually returned exit code 0 above (this function
 * throws before reaching here on any failure), so `result` is ground truth,
 * never an agent's self-reported summary. Best-effort: a write failure here
 * must never fail a push that already genuinely succeeded.
 */
async function recordLastPush(
  workspaceId: string,
  result: CommitAndPushResult,
): Promise<void> {
  try {
    const db = getV3Db();
    await db
      .update(v3Schema.v3Workspaces)
      .set({
        lastPushSha: result.sha,
        lastPushBranch: result.branch,
        lastPushPrUrl: result.prUrl ?? null,
        lastPushedAt: new Date(),
      })
      .where(eq(v3Schema.v3Workspaces.id, workspaceId));
  } catch (err) {
    console.warn(
      `[v3-workspace-local] recordLastPush failed for ${workspaceId}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
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

// ── CI watch ─────────────────────────────────────────────────────────────────

export interface CiWatchOptions {
  /** Workspace id whose PR/branch CI status is being read. */
  id: string;
  /** Branch to check; defaults to the workspace's stored branch. */
  branch?: string;
  /** "github" (default) reads real check status via `gh pr view`; "none" is an
   * immediate no-op green (repos with no CI configured). */
  ciMode?: "github" | "none";
}

export interface CiCheckStatus {
  name: string;
  status: string | null;
  conclusion: string | null;
  detailsUrl?: string | null;
}

export interface CiWatchResult {
  state: "green" | "red" | "pending" | "none";
  prUrl: string | null;
  /** Real PR lifecycle state from `gh pr view` ("OPEN"/"MERGED"/"CLOSED"), or
   *  null when it couldn't be read (ciMode=none, gh unavailable, view failed). */
  prState: string | null;
  checks: CiCheckStatus[];
  summary: string;
}

const CI_PASSING_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/**
 * Read the current CI status for a workspace's PR branch. A single snapshot
 * read (no internal polling loop) — callers (the orchestrating brain) poll
 * this on their own cadence rather than have a server action block for
 * minutes. `ciMode: "none"` short-circuits to a green no-op without touching
 * git/gh at all, per project_repos.ciMode semantics.
 */
export async function ciWatch(opts: CiWatchOptions): Promise<CiWatchResult> {
  if (opts.ciMode === "none") {
    return {
      state: "none",
      prUrl: null,
      prState: null,
      checks: [],
      summary:
        "ciMode=none — no CI configured for this repo; treated as green.",
    };
  }

  const dir = await getLocalWorkspaceDir(opts.id);
  if (!dir) {
    throw new Error(
      `ciWatch: workspace '${opts.id}' not found or has no host_path`,
    );
  }

  const db = getV3Db();
  const [row] = await db
    .select({ branch: v3Schema.v3Workspaces.branch })
    .from(v3Schema.v3Workspaces)
    .where(eq(v3Schema.v3Workspaces.id, opts.id))
    .limit(1);
  const branch = opts.branch ?? row?.branch ?? undefined;
  if (!branch || branch.trim() === "") {
    throw new Error(`ciWatch: no branch known for workspace '${opts.id}'`);
  }

  if (!(await hasGh())) {
    return {
      state: "pending",
      prUrl: null,
      prState: null,
      checks: [],
      summary:
        "gh CLI unavailable — cannot query CI status; treating as pending.",
    };
  }

  const token = await resolveGithubToken();
  const env: Record<string, string> = token ? { GH_TOKEN: token } : {};
  const res = await gh(
    ["pr", "view", branch, "--json", "url,state,statusCheckRollup"],
    { cwd: dir, env },
  );
  if (res.code !== 0) {
    return {
      state: "pending",
      prUrl: null,
      prState: null,
      checks: [],
      summary: `gh pr view failed (exit ${res.code}): ${redact(res.stderr.trim(), token)}`,
    };
  }

  let info: {
    url?: string;
    state?: string;
    statusCheckRollup?: Array<Record<string, unknown>>;
  };
  try {
    info = JSON.parse(res.stdout);
  } catch {
    return {
      state: "pending",
      prUrl: null,
      prState: null,
      checks: [],
      summary: "gh pr view returned non-JSON output.",
    };
  }

  const rollup = info.statusCheckRollup ?? [];
  const checks: CiCheckStatus[] = rollup.map((c) => ({
    name: String(c.name ?? c.context ?? "check"),
    status: c.status != null ? String(c.status) : null,
    conclusion:
      (c.conclusion ?? c.state) != null
        ? String(c.conclusion ?? c.state)
        : null,
    detailsUrl: c.detailsUrl != null ? String(c.detailsUrl) : null,
  }));

  if (checks.length === 0) {
    return {
      state: "pending",
      prUrl: info.url ?? null,
      prState: info.state ?? null,
      checks: [],
      summary: "No CI checks reported yet.",
    };
  }

  const stillRunning = checks.some((c) => c.status && c.status !== "COMPLETED");
  const failing = checks.filter(
    (c) => c.conclusion != null && !CI_PASSING_CONCLUSIONS.has(c.conclusion),
  );

  if (failing.length > 0) {
    return {
      state: "red",
      prUrl: info.url ?? null,
      prState: info.state ?? null,
      checks,
      summary: `${failing.length} check(s) failing: ${failing.map((c) => c.name).join(", ")}`,
    };
  }
  if (stillRunning) {
    return {
      state: "pending",
      prUrl: info.url ?? null,
      prState: info.state ?? null,
      checks,
      summary: "CI checks still running.",
    };
  }
  return {
    state: "green",
    prUrl: info.url ?? null,
    prState: info.state ?? null,
    checks,
    summary: `All ${checks.length} check(s) passing.`,
  };
}

// ── Merge PR ─────────────────────────────────────────────────────────────────

/**
 * An explicit, audited exception for ONE specific CI check that is currently
 * failing for a confirmed pre-existing/unrelated reason (SDLC-096 fix,
 * 2026-07-23). This is deliberately per-merge-call, never a standing config
 * toggle: the caller must name the exact check and state why, every time —
 * so a future genuinely-new failure under the same check name is NOT silently
 * covered by stale reasoning, and the framework's automatic action-audit log
 * (see the `audit-log` skill) durably records who/when/which-checks/why for
 * every merge that used one.
 */
export interface MergeCheckOverride {
  /** Exact CI check name as reported by `statusCheckRollup` (e.g. "Fast tests"). */
  checkName: string;
  /** Why this specific check's current failure is known-unrelated. Required — an empty/missing reason is not a valid override. */
  reason: string;
}

export interface MergePrOptions {
  /** Workspace id whose PR branch is being merged. */
  id: string;
  branch?: string;
  /** PR base branch; defaults to "main". */
  baseBranch?: string;
  mergeMethod?: "merge" | "squash" | "rebase";
  /**
   * Named, reasoned exceptions for specific currently-failing checks (see
   * {@link MergeCheckOverride}). Every other non-passing check still blocks
   * exactly as before — this is a narrow, audited carve-out, not a relaxed
   * default. A `checkName` that isn't actually failing right now is simply a
   * no-op (does not affect an otherwise-passing check).
   */
  checkOverrides?: MergeCheckOverride[];
}

export interface MergePrResult {
  merged: boolean;
  /** Set when merged=false — e.g. "ci_not_green", "rebase_needed: ...", "locked". */
  reason?: string;
  sha?: string | null;
  prUrl?: string | null;
  /** Checks that were failing but excused via a supplied checkOverrides entry. */
  overriddenChecks?: MergeCheckOverride[];
}

/**
 * Merge a PR after asserting CI is green and the branch is mergeable against
 * its base with no conflicts/staleness. Serializes concurrent merges onto the
 * same base branch with a Postgres advisory lock so two runs targeting the
 * same base branch never race `gh pr merge`. Never force-merges: when the
 * branch needs a rebase/update, this returns `{ merged: false, reason:
 * "rebase_needed: ..." }` instead of overriding — callers should re-run the
 * full dev→qa→review→gate cycle on the refreshed base, not just retry the
 * merge node.
 *
 * `checkOverrides` (SDLC-096 fix) is the ONLY way to merge past a non-passing
 * check — there is still no blanket force-merge. Each entry excuses exactly
 * one NAMED check for exactly this call, with a required reason; every other
 * failing check still blocks. This turns the informal practice this project
 * had been doing manually (verify a failure is pre-existing/unrelated, then
 * bypass the sanctioned gate via a raw `gh pr merge` with zero record of that
 * judgment call) into an explicit, narrow, and durably audited exception —
 * the framework's automatic per-action audit log captures who/when/which
 * checks/why for every call that supplies one (see the `audit-log` skill).
 *
 * Lock is TRANSACTION-scoped (`pg_try_advisory_xact_lock`), not session-scoped
 * — same reasoning as the reconciler's tick() lock (v3-reconciler.ts): `db`
 * here is the shared framework POOL (`getV3Db()`/`getDbExec()`), so a
 * session-scoped `pg_try_advisory_lock`/`pg_advisory_unlock` pair can acquire
 * and release on two different pooled connections, which either errors or
 * leaks the lock forever. The xact lock is guaranteed to release when this
 * transaction's callback returns or throws, on the SAME connection that took
 * it — no manual unlock/finally needed.
 */
export async function mergePr(opts: MergePrOptions): Promise<MergePrResult> {
  const dir = await getLocalWorkspaceDir(opts.id);
  if (!dir) {
    throw new Error(
      `mergePr: workspace '${opts.id}' not found or has no host_path`,
    );
  }

  const db = getV3Db();
  const [row] = await db
    .select({
      branch: v3Schema.v3Workspaces.branch,
      repoUrl: v3Schema.v3Workspaces.repoUrl,
    })
    .from(v3Schema.v3Workspaces)
    .where(eq(v3Schema.v3Workspaces.id, opts.id))
    .limit(1);

  const branch = opts.branch ?? row?.branch ?? undefined;
  if (!branch || branch.trim() === "") {
    throw new Error(`mergePr: no branch known for workspace '${opts.id}'`);
  }
  const remote = row?.repoUrl?.trim();
  if (!remote) {
    throw new Error(`mergePr: workspace '${opts.id}' has no repo_url`);
  }
  const base =
    opts.baseBranch && opts.baseBranch.trim() !== ""
      ? opts.baseBranch.trim()
      : "main";

  if (!(await hasGh())) {
    return {
      merged: false,
      reason: "gh CLI unavailable — cannot merge safely",
    };
  }

  const token = await resolveGithubToken();
  const env: Record<string, string> = token ? { GH_TOKEN: token } : {};
  const slug = parseGithubSlug(remote);
  const lockKey = slug
    ? `${slug.owner}/${slug.repo}:${base}`
    : `${remote}:${base}`;

  return getDbExec().transaction!(async (tx) => {
    const { rows } = await tx.execute({
      sql: "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked",
      args: [lockKey],
    });
    if (!(rows[0]?.locked ?? false)) {
      return {
        merged: false,
        reason: `another merge is in progress for '${lockKey}'`,
      };
    }

    const viewRes = await gh(
      [
        "pr",
        "view",
        branch,
        "--json",
        "url,mergeable,mergeStateStatus,state,statusCheckRollup",
      ],
      { cwd: dir, env },
    );
    if (viewRes.code !== 0) {
      return {
        merged: false,
        reason: `gh pr view failed: ${redact(viewRes.stderr.trim(), token)}`,
      };
    }

    let info: {
      url?: string;
      mergeable?: string;
      mergeStateStatus?: string;
      state?: string;
      statusCheckRollup?: Array<Record<string, unknown>>;
    };
    try {
      info = JSON.parse(viewRes.stdout);
    } catch {
      return { merged: false, reason: "gh pr view returned non-JSON output" };
    }

    if (info.state && info.state !== "OPEN") {
      return {
        merged: false,
        reason: `PR state is '${info.state}', not OPEN`,
        prUrl: info.url ?? null,
      };
    }

    const rollup = info.statusCheckRollup ?? [];
    const failing = rollup.filter((c) => {
      const status = c.status != null ? String(c.status) : null;
      const conclusion =
        (c.conclusion ?? c.state) != null
          ? String(c.conclusion ?? c.state)
          : null;
      const stillRunning = status != null && status !== "COMPLETED";
      return (
        stillRunning ||
        (conclusion != null && !CI_PASSING_CONCLUSIONS.has(conclusion))
      );
    });

    // checkOverrides (SDLC-096): only excuses a check that is COMPLETE and
    // non-passing right now — never one that's still running (an override is
    // a judgment that a specific, already-observed failure is pre-existing/
    // unrelated; there is nothing to judge yet on a check still in flight).
    // Matching is by exact name (case-insensitive, trimmed) so a stale or
    // misspelled override name silently overrides nothing rather than
    // widening scope.
    const overridesByName = new Map(
      (opts.checkOverrides ?? [])
        .filter((o) => o.reason.trim() !== "")
        .map((o) => [o.checkName.trim().toLowerCase(), o]),
    );
    const overriddenChecks: MergeCheckOverride[] = [];
    const stillBlocking = failing.filter((c) => {
      const status = c.status != null ? String(c.status) : null;
      const stillRunning = status != null && status !== "COMPLETED";
      if (stillRunning) return true;
      const name = String(c.name ?? c.context ?? "")
        .trim()
        .toLowerCase();
      const override = overridesByName.get(name);
      if (!override) return true;
      overriddenChecks.push(override);
      return false;
    });

    if (stillBlocking.length > 0) {
      return {
        merged: false,
        reason: `ci_not_green: ${stillBlocking.length} check(s) not passing`,
        prUrl: info.url ?? null,
        ...(overriddenChecks.length > 0 ? { overriddenChecks } : {}),
      };
    }

    if (info.mergeable === "CONFLICTING") {
      return {
        merged: false,
        reason: "rebase_needed: PR has merge conflicts with base branch",
        prUrl: info.url ?? null,
      };
    }
    if (info.mergeStateStatus === "BEHIND") {
      return {
        merged: false,
        reason:
          "rebase_needed: branch is behind base — update needed before merge",
        prUrl: info.url ?? null,
      };
    }

    const method = opts.mergeMethod ?? "merge";
    const methodFlag =
      method === "squash"
        ? "--squash"
        : method === "rebase"
          ? "--rebase"
          : "--merge";
    // Still no force/admin-override flag to `gh pr merge` itself — a merge gh
    // refuses (real conflicts, branch protection, etc.) stays unmerged and is
    // reported back, never overridden. checkOverrides only ever narrows OUR
    // OWN pre-merge CI-gate check above; it never touches this call.
    const mergeRes = await gh(
      ["pr", "merge", branch, methodFlag, "--delete-branch=false"],
      { cwd: dir, env },
    );
    if (mergeRes.code !== 0) {
      return {
        merged: false,
        reason: `gh pr merge failed: ${redact(`${mergeRes.stdout}\n${mergeRes.stderr}`.trim(), token)}`,
        prUrl: info.url ?? null,
        ...(overriddenChecks.length > 0 ? { overriddenChecks } : {}),
      };
    }

    // Refresh the local remote-tracking ref before reading it back — `gh pr
    // merge` merges via the GitHub API, so the local clone's `origin/<base>`
    // is stale until fetched.
    await git(["fetch", "origin", base], { cwd: dir }).catch(() => null);
    const head = await git(["rev-parse", `origin/${base}`], { cwd: dir }).catch(
      () => null,
    );
    return {
      merged: true,
      sha: head?.stdout?.trim() ?? null,
      prUrl: info.url ?? null,
      ...(overriddenChecks.length > 0 ? { overriddenChecks } : {}),
    };
  });
}

// ── Secret-leak defense (DESIGN §13 hardening) ───────────────────────────────

/** Glob patterns for files that must NEVER be committed (carry live bearers). */
const MCP_CONFIG_PATTERNS = [
  ".mcp.json",
  "*.mcp.json",
  "**/.mcp.json",
  "**/*.mcp.json",
];

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
  const jwtRe =
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;
  for (const line of added) {
    if (bearerRe.test(line) || jwtRe.test(line)) {
      // Identify the offending file for the error (best-effort).
      const names = await git(["diff", "--cached", "--name-only"], {
        cwd: dir,
      });
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
