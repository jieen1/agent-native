// F1 workspace contract — W2/W3 supply pipeline (DESIGN 02-workflows.md §7;
// SDLC-057 dev-has-no-vitest, SDLC-061 migration-smoke gap) + the shared
// readiness/diff-base error types (W1-W4).
//
// Host-native only: this module shells out via `node:child_process` on the
// HOST (no VM). The git-worktree/clone adapter (`v3-workspace-local.ts`) is
// the only currently-exercised workspace path in the Docker deployment
// (MicrosandboxRuntime is unavailable there — see that file's header), so
// this is where W2 (dependency prewarming) and W3 (test-executability smoke)
// actually run. The microVM adapter (`server/engine/v3-workspace.ts`) execs
// the equivalent commands INSIDE the sandboxed VM via
// `MicrosandboxRuntime.exec()` instead of this module's `execCmd` — see the
// readiness note in that file for why full W2/W3 there is out of scope this
// pass.

import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

// ── Errors ───────────────────────────────────────────────────────────────────

/** Which of the three readiness invariants failed (02-workflows.md §7). */
export type ReadinessStage = "W1" | "W2" | "W3";

/**
 * A workspace failed one of the three readiness invariants — W1 baseline
 * freshness (merge-base distance 0 vs the target branch), W2 dependency
 * warmth (`node_modules` usable), or W3 test executability (`test_cmd_smoke`
 * exits 0). ALWAYS classified `infra`: a not-ready workspace is an
 * environment/supply-chain condition, never an agent failure — the
 * dispatcher must reject dispatch on it rather than count it against the
 * node/agent (DESIGN §7 "就绪不变量").
 */
export class WorkspaceNotReadyError extends Error {
  readonly stage: ReadinessStage;
  readonly detail: string;
  readonly errorClass = "infra" as const;

  constructor(stage: ReadinessStage, detail: string) {
    super(`workspace not ready (${stage}): ${detail}`);
    this.name = "WorkspaceNotReadyError";
    this.stage = stage;
    this.detail = detail;
  }
}

/**
 * W4 (SDLC-059) — the observed diff/merge-base could not be resolved
 * (target branch missing upstream, no common ancestor, or a network/timeout
 * failure while refreshing the mirror). Thrown INSTEAD of silently degrading
 * through `origin/main` → `origin/master` → `HEAD~1` → the empty tree — the
 * B4 false-diff root cause. Callers (`workspaceDiff` action, `runSummary`'s
 * diff stats) must catch this and return `{ error: "diff-base-unresolvable",
 * detail }` — never a diff computed against a guessed/stale base.
 */
export class DiffBaseUnresolvableError extends Error {
  readonly dir: string;
  readonly targetBranch: string;
  readonly detail: string;

  constructor(dir: string, targetBranch: string, detail: string) {
    super(
      `diff base unresolvable for workspace dir '${dir}' against '${targetBranch}': ${detail}`,
    );
    this.name = "DiffBaseUnresolvableError";
    this.dir = dir;
    this.targetBranch = targetBranch;
    this.detail = detail;
  }
}

// ── Generic exec ─────────────────────────────────────────────────────────────

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Execute `command` (a full shell command string, e.g. a configurable
 * `test_cmd_smoke`) with a bound timeout. NEVER throws or rejects — a timeout
 * or spawn error is reported via the returned result (`code:-1`,
 * `timedOut:true`) so callers decide what failure means.
 */
export function execCmd(
  command: string,
  opts: { cwd: string; timeoutMs: number; env?: Record<string, string> },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        shell: true,
        // Own process group so the timeout can SIGKILL the WHOLE tree. With
        // `shell:true`, `spawn("sleep 30")` runs `/bin/sh -c "sleep 30"`;
        // killing only the sh parent orphans `sleep`, which keeps the stdout
        // pipe open so `close` never fires (the child appears to hang for the
        // full 30s). Killing the group (`-pid`) reaps sh AND sleep.
        detached: true,
      });
    } catch (err) {
      resolve({
        code: -1,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        timedOut: false,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    let stdout = "";
    let stderr = "";

    const finish = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      // Kill the whole process group (negative pid). Fall back to a direct
      // kill if the group signal fails (e.g. pid already gone).
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }
    }, opts.timeoutMs);

    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      finish({
        code: -1,
        stdout,
        stderr: stderr ? `${stderr}\n${err.message}` : err.message,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
    // Resolve on `exit` (fires when the process exits, independent of whether
    // orphaned grandchildren still hold stdio) rather than `close` — a timed-
    // out group-kill reaps the tree, so exit fires promptly and we don't wait
    // out a runaway grandchild's stdio EOF.
    child.on("exit", (code) => {
      finish({
        code: timedOut ? -1 : (code ?? -1),
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

// ── Monorepo-aware vitest resolution ────────────────────────────────────────
//
// SDLC-0xx (dogfood false-positive, 07-16 board #47/#72): W2/W3 both invoke
// `pnpm exec vitest ...`. For the original single-app-repo shape `dir` IS the
// vitest-declaring package, so that always worked. The dogfood project's repo
// is a MIRROR OF THIS MONOREPO — `dir` is the pnpm WORKSPACE root, whose own
// package.json never lists `vitest` (every template/package declares it
// individually via `"vitest": "catalog:"`, per this repo's own
// pnpm-workspace.yaml). `pnpm exec` resolves bins from the invoking package's
// own dependencies, not the whole workspace, so `pnpm exec vitest --version`
// run AT the workspace root can never succeed — even right after a fully
// successful `pnpm install` — and W2 never passes (ERR_PNPM_RECURSIVE_EXEC_
// FIRST_FAIL, reproduced independently twice on 101).

async function packageDeclaresVitest(pkgDir: string): Promise<boolean> {
  try {
    const raw = await readFile(join(pkgDir, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    return Boolean(pkg.dependencies?.vitest ?? pkg.devDependencies?.vitest);
  } catch {
    return false;
  }
}

async function listSubdirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter(
        (e) =>
          e.isDirectory() &&
          e.name !== "node_modules" &&
          !e.name.startsWith("."),
      )
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Resolve the directory W2/W3 should actually invoke `pnpm exec vitest` in.
 *
 * Returns `dir` unchanged whenever `dir`'s own package.json already declares
 * `vitest` (the original single-app-repo assumption) — zero behavior change
 * for that shape, including a genuinely broken/uninstalled workspace (still
 * fails exactly as before; this never widens what counts as "warm").
 *
 * Otherwise walks `dir`'s immediate children and grandchildren (bounded — no
 * `node_modules`/dotdir descent, no pnpm-workspace.yaml glob parsing) for the
 * first package.json that declares `vitest`, e.g. `templates/orchestrator` in
 * this repo's own shape, and scopes the probe/smoke command into THAT
 * directory instead. Falls back to `dir` when nothing is found anywhere, so a
 * workspace where NO package resolves vitest still correctly fails W2/W3.
 */
export async function resolveVitestProjectDir(dir: string): Promise<string> {
  if (await packageDeclaresVitest(dir)) return dir;

  const level1 = await listSubdirs(dir);
  for (const name of level1) {
    const child = join(dir, name);
    if (await packageDeclaresVitest(child)) return child;
  }
  for (const name of level1) {
    const parent = join(dir, name);
    for (const sub of await listSubdirs(parent)) {
      const grandchild = join(parent, sub);
      if (await packageDeclaresVitest(grandchild)) return grandchild;
    }
  }

  return dir;
}

// ── W2: dependency prewarming ────────────────────────────────────────────────

/** Shared pnpm store dir (hardlink cache — DESIGN §7 "共享 pnpm store 硬链"). */
export function resolvePnpmStoreDir(): string {
  const raw = process.env.ORCH_PNPM_STORE?.trim();
  return raw && raw !== "" ? raw : "/workspaces/.pnpm-store";
}

// ── W2/W3 timeout bounds (board #88) ────────────────────────────────────────
//
// A large monorepo checkout (the SDLC自举 dogfood repo — a mirror of THIS
// monorepo) makes W2's `pnpm install` a materially heavier operation than the
// original single-app-repo shape assumed: the whole-workspace install also
// runs several packages' postinstall builds (core, pinpoint, scheduling,
// dispatch, locale-kit, …), and installs that race for the SAME shared
// `--store-dir` (resolvePnpmStoreDir() above — one store for every workspace,
// not one per repo) queue up under concurrent workspace creation instead of
// running in parallel. Reproduced directly against a real disposable checkout
// of this repo (board #88): a solo cold install completed in ~36s, but the
// SAME install run 3-way concurrently against the shared store-dir stretched
// to ~55s each — on a slower/busier host (or with more concurrent workspace
// creates, which V3 routinely does) that curve crosses the OLD 120s default.
// Notably `v3-workspace-provision.spec.ts`'s own real end-to-end reproduction
// against this repo's monorepo root already had to pass explicit
// `probeTimeoutMs`/`installTimeoutMs` overrides larger than the (until now)
// hardcoded production defaults just to pass reliably — evidence this gap was
// already being routed around in tests, never actually fixed in the path
// `assertWorkspaceReady` calls in production.
//
// Distinct from board #72 (which fixed WHERE `pnpm exec vitest` runs — the
// monorepo-root-lacks-its-own-vitest cwd problem, `resolveVitestProjectDir`
// above): this is HOW LONG W2/W3 are allowed to run, an independent axis. Both
// are real, both are specifically triggered by the large dogfood monorepo.
//
// Configurable via env (mirrors `resolveGitTimeoutMs` in
// v3-workspace-local.ts) so an operator can widen these for a demonstrably
// slower/larger checkout without a code change; an explicit call-site
// `opts.probeTimeoutMs`/`installTimeoutMs`/`timeoutMs` still wins over both.

const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 300_000;
const DEFAULT_SMOKE_TIMEOUT_MS = 180_000;

function resolveTimeoutMsEnv(envVar: string, fallback: number): number {
  const raw = Number(process.env[envVar]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** W2 warm-probe timeout (`pnpm exec vitest --version`). `ORCH_PNPM_PROBE_TIMEOUT_MS` overrides. */
export function resolveProbeTimeoutMs(): number {
  return resolveTimeoutMsEnv(
    "ORCH_PNPM_PROBE_TIMEOUT_MS",
    DEFAULT_PROBE_TIMEOUT_MS,
  );
}

/** W2 `pnpm install` timeout. `ORCH_PNPM_INSTALL_TIMEOUT_MS` overrides. */
export function resolveInstallTimeoutMs(): number {
  return resolveTimeoutMsEnv(
    "ORCH_PNPM_INSTALL_TIMEOUT_MS",
    DEFAULT_INSTALL_TIMEOUT_MS,
  );
}

/** W3 `test_cmd_smoke` timeout. `ORCH_SMOKE_TIMEOUT_MS` overrides. */
export function resolveSmokeTimeoutMs(): number {
  return resolveTimeoutMsEnv("ORCH_SMOKE_TIMEOUT_MS", DEFAULT_SMOKE_TIMEOUT_MS);
}

export interface DepWarmReport {
  ok: boolean;
  /** True when a `pnpm install` had to run (the fast probe missed). */
  installed: boolean;
  probeOutput: string;
  installOutput: string | null;
  durationMs: number;
  /**
   * The directory the probe actually ran in. Equals `dir` for a standalone
   * single-app repo; a monorepo checkout whose OWN package.json doesn't
   * declare `vitest` resolves to the first workspace member that does (see
   * {@link resolveVitestProjectDir}) — kept on the report so `ready_report`
   * shows WHERE warmth was proven, not just that it was.
   */
  probeDir: string;
}

export interface DepWarmOptions {
  pnpmStoreDir?: string;
  probeTimeoutMs?: number;
  installTimeoutMs?: number;
  /** Injection point for tests — defaults to the real {@link execCmd}. */
  exec?: typeof execCmd;
}

/**
 * W2 — dependencies already warm: `pnpm exec vitest --version` exits 0.
 * On a miss, runs `pnpm install --prefer-offline --store-dir <store>` (the
 * shared hardlink cache, seconds not minutes) and re-probes. Throws
 * `WorkspaceNotReadyError('W2', …)` when the re-probe still fails — a node
 * never runs `pnpm install` itself (DESIGN §7: "职责归供给,不归 agent").
 *
 * The probe/re-probe run in {@link resolveVitestProjectDir}'s resolution of
 * `dir` (itself, unless `dir` is a monorepo root that doesn't declare vitest
 * — see that function). `pnpm install` always targets `dir` itself: it's a
 * whole-workspace operation regardless of cwd depth, so scoping it would be a
 * no-op at best and is left unchanged.
 */
export async function assertDependenciesWarm(
  dir: string,
  opts: DepWarmOptions = {},
): Promise<DepWarmReport> {
  const exec = opts.exec ?? execCmd;
  const probeTimeoutMs = opts.probeTimeoutMs ?? resolveProbeTimeoutMs();
  const installTimeoutMs = opts.installTimeoutMs ?? resolveInstallTimeoutMs();
  const startedAt = Date.now();
  const probeDir = await resolveVitestProjectDir(dir);

  const probe = await exec("pnpm exec vitest --version", {
    cwd: probeDir,
    timeoutMs: probeTimeoutMs,
  });
  if (probe.code === 0) {
    return {
      ok: true,
      installed: false,
      probeOutput: probe.stdout || probe.stderr,
      installOutput: null,
      durationMs: Date.now() - startedAt,
      probeDir,
    };
  }

  const storeDir = opts.pnpmStoreDir ?? resolvePnpmStoreDir();
  const install = await exec(
    `pnpm install --prefer-offline --store-dir "${storeDir}"`,
    { cwd: dir, timeoutMs: installTimeoutMs },
  );

  const reprobe = await exec("pnpm exec vitest --version", {
    cwd: probeDir,
    timeoutMs: probeTimeoutMs,
  });

  if (reprobe.code !== 0) {
    throw new WorkspaceNotReadyError(
      "W2",
      `pnpm exec vitest --version failed after install (exit ${reprobe.code}, probeDir=${probeDir}). ` +
        `install output: ${(install.stdout + install.stderr).slice(-2000)} ` +
        `reprobe output: ${(reprobe.stdout + reprobe.stderr).slice(-500)}`,
    );
  }

  return {
    ok: true,
    installed: true,
    probeOutput: reprobe.stdout || reprobe.stderr,
    installOutput: (install.stdout + install.stderr).slice(-4000),
    durationMs: Date.now() - startedAt,
    probeDir,
  };
}

// ── W3: test-executability smoke ─────────────────────────────────────────────

/**
 * Default W3 smoke command. `--passWithNoTests` so a template with zero test
 * files doesn't block readiness forever; T-F1-07 overrides this per-call
 * (dropping the flag) to prove the mechanism actually executes real tests
 * rather than rubber-stamping an empty directory.
 */
export const DEFAULT_TEST_CMD_SMOKE =
  "pnpm exec vitest run --passWithNoTests --dir actions/__tests__ --reporter=dot";

export function resolveTestCmdSmoke(override?: string | null): string {
  return override && override.trim() !== ""
    ? override.trim()
    : DEFAULT_TEST_CMD_SMOKE;
}

export interface SmokeReport {
  ok: boolean;
  command: string;
  exitCode: number;
  output: string;
  /** Best-effort parsed test count from the reporter output; null if unparseable. */
  testsRun: number | null;
  durationMs: number;
  /** The directory `command` actually ran in — see {@link runTestCmdSmoke}. */
  execDir: string;
}

export interface SmokeOptions {
  /** Project-level override for `test_cmd_smoke` (tracker project settings). */
  command?: string | null;
  timeoutMs?: number;
  /** Injection point for tests — defaults to the real {@link execCmd}. */
  exec?: typeof execCmd;
}

const TESTS_RUN_RE = /Tests\s+(\d+)\s+passed/i;
const TESTS_RUN_ALT_RE = /(\d+)\s+passed/i;

function parseTestsRun(output: string): number | null {
  const m = TESTS_RUN_RE.exec(output) ?? TESTS_RUN_ALT_RE.exec(output);
  return m ? Number(m[1]) : null;
}

/**
 * W3 — run `test_cmd_smoke` (real subprocess, bounded by
 * {@link resolveSmokeTimeoutMs} per DESIGN §7). A non-zero exit (including a
 * timeout) throws `WorkspaceNotReadyError('W3', …)`; the workspace never
 * reaches `ready_at`.
 *
 * The DEFAULT command shells out to `pnpm exec vitest`, which hits the exact
 * same monorepo-root resolution problem as W2 (see
 * {@link resolveVitestProjectDir}) — so the default command's cwd is resolved
 * the same way. An explicit project-level override (`opts.command` set) is
 * respected literally at `dir` — an operator who configured their own command
 * owns its working directory; auto-relocating it could silently break a
 * command that assumes repo-root-relative paths.
 */
export async function runTestCmdSmoke(
  dir: string,
  opts: SmokeOptions = {},
): Promise<SmokeReport> {
  const exec = opts.exec ?? execCmd;
  const usingDefault = !opts.command || opts.command.trim() === "";
  const command = resolveTestCmdSmoke(opts.command);
  const timeoutMs = opts.timeoutMs ?? resolveSmokeTimeoutMs();
  const execDir = usingDefault ? await resolveVitestProjectDir(dir) : dir;
  const res = await exec(command, { cwd: execDir, timeoutMs });
  const output = `${res.stdout}\n${res.stderr}`.trim();

  if (res.timedOut) {
    throw new WorkspaceNotReadyError(
      "W3",
      `test_cmd_smoke timed out after ${timeoutMs}ms: ${command}`,
    );
  }
  if (res.code !== 0) {
    throw new WorkspaceNotReadyError(
      "W3",
      `test_cmd_smoke failed (exit ${res.code}, execDir=${execDir}): ${command}\n${output.slice(-2000)}`,
    );
  }

  return {
    ok: true,
    command,
    exitCode: res.code,
    output: output.slice(-4000),
    testsRun: parseTestsRun(output),
    durationMs: res.durationMs,
    execDir,
  };
}
