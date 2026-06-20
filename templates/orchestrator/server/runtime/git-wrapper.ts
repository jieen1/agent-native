// Thin in-VM git wrapper (DESIGN §7.1 / §7.1a). git checkout/branch/add/commit/
// push and PR-open all happen INSIDE the node's microVM, over `runtime.exec`
// (→ `msb exec`). There are NO git deps in the host repo by design (§7.1) — this
// is the whole git surface, built over the VM shell.
//
// Branch lifecycle (§7.1a): ONE branch per run, `an/run-<runId>`, cut from
// `baseRef`. The microVM is disposable; the only durable artifact is the PUSHED
// branch / PR. Push is NEVER assumed to succeed — a non-fast-forward rejection,
// a missing token, or a network failure surfaces as a structured failure with a
// clear message (the node fails), and a `{kind:"pr"}` deliverable is produced
// ONLY when a real PR URL exists.
//
// Push auth (§7.1 / §7.4.7): GITHUB_TOKEN is injected as scoped VM env and used
// via an EPHEMERAL `https://x-access-token:<token>@github.com/...` remote URL
// passed to a single `git push <url>` — the token never lands in the repo config
// or in any committed file. (`gh` reuses GH_TOKEN from env for the PR step.)

import type { ExecResult, NodeRuntime, VmHandle } from "./node-runtime.js";

/** Single-quote a value for safe interpolation into the in-VM POSIX shell. */
function shArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Redact every occurrence of `secret` from `text` (token-safe diagnostics). */
function redact(text: string, secret: string): string {
  if (!secret) return text;
  const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(escaped, "g"), "***");
}

/** Deterministic per-run branch name (§7.1a): one branch per run. */
export function runBranchName(runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9._-]/g, "-");
  return `an/run-${safe}`;
}

/** Options shared by every git op: the worktree cwd + the injected env. */
export interface GitContext {
  runtime: NodeRuntime;
  vm: VmHandle;
  /** The in-VM worktree directory (cwd for every git command). */
  workdir: string;
  /** Env to thread (HOME, GITHUB_TOKEN, egress/proxy). */
  env: Record<string, string>;
}

/** Result of the push step — push is allowed to FAIL meaningfully (§7.1). */
export interface PushResult {
  pushed: boolean;
  /** "ok" | "no-token" | "non-fast-forward" | "no-remote" | "error". */
  reason: string;
  /** The full git push stderr/stdout tail for diagnostics. */
  detail: string;
}

/** Result of opening a PR — a PR URL exists ONLY when `url` is set (§7.1). */
export interface OpenPrResult {
  opened: boolean;
  url: string | null;
  /** "ok" | "no-gh" | "no-token" | "error". */
  reason: string;
  detail: string;
}

/** Run one git command in the worktree with the injected env. */
async function git(ctx: GitContext, args: string): Promise<ExecResult> {
  return ctx.runtime.exec(ctx.vm, `git ${args}`, {
    cwd: ctx.workdir,
    env: ctx.env,
    timeoutMs: 120_000,
  });
}

/**
 * Ensure a git repo + identity exist in the worktree, then create/switch to the
 * per-run branch from `baseRef` (§7.1a). For a worktree that is already a clone
 * we branch off `baseRef`; for a bare/empty worktree we `git init` so commits can
 * accumulate (a remote-less smoke still proves branch+commit). Returns the
 * branch name actually checked out. A non-zero git code throws with context.
 */
export async function checkoutRunBranch(
  ctx: GitContext,
  opts: { branch: string; baseRef?: string },
): Promise<{ branch: string; initialized: boolean }> {
  const isRepo = await git(ctx, "rev-parse --is-inside-work-tree");
  let initialized = false;
  if (isRepo.code !== 0) {
    const init = await git(ctx, "init -q");
    if (init.code !== 0) {
      throw new Error(`git init failed: ${init.stderr || init.stdout}`);
    }
    initialized = true;
  }

  // A deterministic identity so commits succeed in a fresh VM (§7.1a). These are
  // non-secret bot identifiers, safe to set inline.
  await git(ctx, `config user.email ${shArg("orchestrator@an.local")}`);
  await git(ctx, `config user.name ${shArg("Orchestrator Run")}`);

  // Branch from baseRef when it resolves; otherwise create the branch on the
  // current HEAD (fresh repo). `checkout -B` is idempotent across retries.
  const base = opts.baseRef && opts.baseRef.trim() !== "" ? opts.baseRef : "";
  let checkout: ExecResult;
  if (base) {
    const baseExists = await git(ctx, `rev-parse --verify ${shArg(base)}`);
    checkout =
      baseExists.code === 0
        ? await git(ctx, `checkout -B ${shArg(opts.branch)} ${shArg(base)}`)
        : await git(ctx, `checkout -B ${shArg(opts.branch)}`);
  } else {
    checkout = await git(ctx, `checkout -B ${shArg(opts.branch)}`);
  }
  if (checkout.code !== 0) {
    throw new Error(
      `git checkout -B ${opts.branch} failed: ${
        checkout.stderr || checkout.stdout
      }`,
    );
  }
  return { branch: opts.branch, initialized };
}

/** Stage everything in the worktree. */
export async function addAll(ctx: GitContext): Promise<ExecResult> {
  return git(ctx, "add -A");
}

/**
 * Commit staged changes. Returns `{ committed:false }` when there is nothing to
 * commit (a clean tree) — that is NOT an error (a node may legitimately produce
 * no file change). The commit message is passed via stdin-free `-m` with a
 * single-quoted arg so arbitrary text is safe.
 */
export async function commit(
  ctx: GitContext,
  message: string,
): Promise<{ committed: boolean; sha: string | null; detail: string }> {
  const status = await git(ctx, "status --porcelain");
  if (status.code === 0 && status.stdout.trim() === "") {
    return { committed: false, sha: null, detail: "nothing to commit" };
  }
  const res = await git(ctx, `commit -m ${shArg(message)}`);
  if (res.code !== 0) {
    return {
      committed: false,
      sha: null,
      detail: res.stderr || res.stdout,
    };
  }
  const sha = await git(ctx, "rev-parse HEAD");
  return {
    committed: true,
    sha: sha.code === 0 ? sha.stdout.trim() : null,
    detail: res.stdout,
  };
}

/**
 * Push the run branch to `remoteUrl` (an `https://github.com/<owner>/<repo>.git`
 * URL) using GITHUB_TOKEN (§7.1). Push is NOT assumed to succeed:
 *   • no token in env            → { pushed:false, reason:"no-token" }
 *   • no remote URL provided     → { pushed:false, reason:"no-remote" }
 *   • non-fast-forward rejection → { pushed:false, reason:"non-fast-forward" }
 *   • any other git failure      → { pushed:false, reason:"error" }
 * The token is embedded in an EPHEMERAL push URL (`x-access-token:<tok>@…`) on a
 * single `git push` invocation — never written to the repo config.
 */
export async function pushBranch(
  ctx: GitContext,
  opts: { branch: string; remoteUrl?: string | null },
): Promise<PushResult> {
  const token = ctx.env.GITHUB_TOKEN;
  if (!token || token.trim() === "") {
    return {
      pushed: false,
      reason: "no-token",
      detail:
        "GITHUB_TOKEN not present in the VM env — cannot authenticate the push. " +
        "Register the secret (resolveSecret('GITHUB_TOKEN')).",
    };
  }
  const remote = opts.remoteUrl?.trim();
  if (!remote) {
    return {
      pushed: false,
      reason: "no-remote",
      detail: "no remote URL provided to pushBranch",
    };
  }

  // Build the authenticated push URL. Only https github remotes are supported.
  const authUrl = remote.replace(
    /^https:\/\/(.*)$/,
    `https://x-access-token:${token}@$1`,
  );
  const res = await git(
    ctx,
    `push ${shArg(authUrl)} ${shArg(`HEAD:refs/heads/${opts.branch}`)} 2>&1`,
  );
  if (res.code === 0) {
    return { pushed: true, reason: "ok", detail: tail(res.stdout) };
  }
  const text = `${res.stdout}\n${res.stderr}`;
  const reason = /non-fast-forward|fetch first|rejected/i.test(text)
    ? "non-fast-forward"
    : "error";
  // Redact the token from any echoed URL before surfacing the detail.
  const safe = redact(tail(text), token);
  return { pushed: false, reason, detail: safe };
}

/**
 * Open a PR for the pushed branch via `gh` (§7.1). A `{kind:"pr"}` deliverable is
 * valid ONLY when this returns a real `url`. Requires `gh` on PATH + a token
 * (passed as GH_TOKEN). Any failure returns `opened:false` with a reason — never
 * a fabricated URL.
 */
export async function openPr(
  ctx: GitContext,
  opts: { branch: string; baseBranch: string; title: string; body?: string },
): Promise<OpenPrResult> {
  const token = ctx.env.GITHUB_TOKEN;
  if (!token || token.trim() === "") {
    return {
      opened: false,
      url: null,
      reason: "no-token",
      detail: "GITHUB_TOKEN not present — cannot open a PR",
    };
  }
  const hasGh = await ctx.runtime.exec(
    ctx.vm,
    "command -v gh >/dev/null 2>&1 && echo OK || echo MISSING",
    { env: ctx.env, cwd: ctx.workdir },
  );
  if (!hasGh.stdout.includes("OK")) {
    return {
      opened: false,
      url: null,
      reason: "no-gh",
      detail: "gh CLI not installed in the VM",
    };
  }
  const body = opts.body ?? "Automated PR from an orchestrator run.";
  const res = await ctx.runtime.exec(
    ctx.vm,
    `gh pr create --base ${shArg(opts.baseBranch)} --head ${shArg(
      opts.branch,
    )} --title ${shArg(opts.title)} --body ${shArg(body)} 2>&1`,
    {
      cwd: ctx.workdir,
      // gh reads GH_TOKEN from env; mirror GITHUB_TOKEN into it.
      env: { ...ctx.env, GH_TOKEN: token },
      timeoutMs: 120_000,
    },
  );
  const out = `${res.stdout}\n${res.stderr}`;
  const urlMatch = /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(out);
  if (res.code === 0 && urlMatch) {
    return { opened: true, url: urlMatch[0], reason: "ok", detail: "" };
  }
  return {
    opened: false,
    url: null,
    reason: "error",
    detail: redact(tail(out), token),
  };
}

/** Last ~400 chars of a stream (compact diagnostics). */
function tail(text: string): string {
  return text.length > 400 ? `…${text.slice(-400)}` : text;
}
