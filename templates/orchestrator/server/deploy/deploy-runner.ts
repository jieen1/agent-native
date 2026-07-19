import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { resolveSecret } from "@agent-native/core/server";
import { eq } from "drizzle-orm";

import { getDb, schema } from "../db/index.js";

const execFileAsync = promisify(execFile);

export type DeployApp = "orchestrator" | "tracker";

export type DeployStage =
  | "queued"
  | "backing-up"
  | "building"
  | "syncing"
  | "restarting"
  | "verifying"
  | "rolling-back"
  | "done";

export interface DeployStageEntry {
  stage: DeployStage;
  startedAt: string;
  completedAt?: string;
  ok?: boolean;
  detail?: string;
}

export interface DeployConfig {
  host: string;
  user: string;
  keyPath: string;
  /**
   * Directory on the deploy host holding a REAL git checkout of THIS SAME
   * monorepo — the build stage runs `git fetch`/`reset --hard`/`pnpm build`
   * here, at `<remoteBasePath>/templates/<app>`, mirroring this repo's own
   * layout, per docs/agent-native-alignment-audit.md §5: "以 main 为准，101
   * 的 orchestrator/tracker .output 从 main 重建部署". This is the BUILD
   * source only — it is NOT assumed to be where the running containers
   * serve from (see `liveBasePath`); on 101 today the real git checkout
   * lives at a separate path from the containers' bind-mounted directory.
   */
  remoteBasePath: string;
  /**
   * Directory the running app containers actually bind-mount their
   * `.output` from — `docker inspect an-orchestrator` is the ground truth,
   * not an assumption. May be a plain rsync/copy target with no `.git` at
   * all (confirmed true for 101: `remoteBasePath` and this are DIFFERENT
   * directories there). The "syncing" stage below copies each app's
   * freshly-built `.output` from `remoteBasePath` to here before restart —
   * without that copy, a build that succeeds in `remoteBasePath` would
   * never actually reach the containers `restartCommand` bounces, and the
   * deploy would silently report success while shipping nothing. Falls back
   * to `remoteBasePath` when unset/blank (single-directory setups, where the
   * copy is skipped because source and destination already coincide).
   */
  liveBasePath?: string;
  healthCheckUrl: string;
  restartCommand: string;
}

const DEFAULT_RESTART_COMMAND = "docker restart an-orchestrator an-tracker";

/**
 * Resolve deploy config from the secrets vault. MUST be called from inside a
 * live request context (an action's `run()`, before returning) — resolveSecret
 * depends on AsyncLocalStorage-scoped request identity that is gone once the
 * detached background job below is running on its own.
 */
export async function loadDeployConfig(): Promise<DeployConfig> {
  const [
    host,
    user,
    keyPath,
    remoteBasePath,
    liveBasePath,
    healthCheckUrl,
    restartCommand,
  ] = await Promise.all([
    resolveSecret("DEPLOY_SSH_HOST"),
    resolveSecret("DEPLOY_SSH_USER"),
    resolveSecret("DEPLOY_SSH_KEY_PATH"),
    resolveSecret("DEPLOY_REMOTE_BASE_PATH"),
    resolveSecret("DEPLOY_LIVE_BASE_PATH"),
    resolveSecret("DEPLOY_HEALTH_CHECK_URL"),
    resolveSecret("DEPLOY_RESTART_COMMAND"),
  ]);
  const missing = [
    ["DEPLOY_SSH_HOST", host],
    ["DEPLOY_SSH_USER", user],
    ["DEPLOY_SSH_KEY_PATH", keyPath],
    ["DEPLOY_REMOTE_BASE_PATH", remoteBasePath],
    ["DEPLOY_HEALTH_CHECK_URL", healthCheckUrl],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(
      `Deploy is not configured — set ${missing.join(", ")} in Settings → Deploy.`,
    );
  }
  return {
    host: host as string,
    user: user as string,
    keyPath: keyPath as string,
    remoteBasePath: remoteBasePath as string,
    liveBasePath: (liveBasePath as string) || undefined,
    healthCheckUrl: healthCheckUrl as string,
    restartCommand: (restartCommand as string) || DEFAULT_RESTART_COMMAND,
  };
}

/**
 * Redact every configured secret literal (host/user/key path) out of a
 * string before it is ever persisted to `deployRuns` or rendered in the UI.
 * Defense-in-depth alongside `sanitizeSshFailure` below — applied at every
 * point an error message is written to the DB, not just at the ssh boundary,
 * so a future non-ssh throw site can never reintroduce the leak.
 */
function redactCfgSecrets(cfg: DeployConfig, text: string): string {
  let out = text;
  for (const secret of [cfg.host, cfg.user, cfg.keyPath]) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out;
}

/**
 * Node's `execFile` embeds the full argv — including `-i <keyPath>` and
 * `<user>@<host>` — into `err.message` on any nonzero exit or connection
 * failure. The rest of that message (the remote command's real stderr/stdout
 * — e.g. a `tsc` error, "No space left on device", "Connection timed out")
 * is genuinely useful and NOT a secret, so this redacts the specific secret
 * literals out of the message rather than discarding it wholesale — a
 * generic "SSH command failed, see server logs" would erase exactly the
 * diagnostic an operator needs to fix a broken deploy. The raw, unredacted
 * error is still logged server-side for anything redaction might miss.
 */
function sanitizeSshFailure(cfg: DeployConfig, err: unknown): Error {
  // eslint-disable-next-line no-console
  console.error("[deploy] ssh command failed (raw, server log only):", err);
  const raw = err instanceof Error ? err.message : String(err);
  return new Error(redactCfgSecrets(cfg, raw));
}

async function sshExec(
  cfg: DeployConfig,
  remoteCommand: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(
      "ssh",
      [
        "-i",
        cfg.keyPath,
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "BatchMode=yes",
        `${cfg.user}@${cfg.host}`,
        remoteCommand,
      ],
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
    );
  } catch (err) {
    throw sanitizeSshFailure(cfg, err);
  }
}

/** Where the app gets BUILT — the git checkout at `remoteBasePath`. */
function buildOutputDir(cfg: DeployConfig, app: DeployApp): string {
  return `${cfg.remoteBasePath}/templates/${app}/.output`;
}

/**
 * Established container-naming convention (`DEFAULT_RESTART_COMMAND`, this
 * file's own tests, `deploy-secrets.ts`'s description text) — not derived
 * from `cfg.restartCommand`, which is an opaque shell string a deployment
 * could customize arbitrarily. Only orchestrator's container ever needs this
 * (see `ensureGhCli`'s doc comment); tracker has no `gh` dependency.
 */
function containerName(app: DeployApp): string {
  return `an-${app}`;
}

/**
 * Idempotent check-then-install of the `gh` CLI INSIDE a running app
 * container. `gh` is a real RUNTIME dependency of the orchestrator's V3
 * workspace surface (`server/v3-workspace-local.ts`: `commitAndPush`'s PR
 * open, CI-status polling, and `workspaceMergePr`'s real `gh pr merge`) — not
 * a build-time toolchain dependency, so `withNodeToolchain`'s host-side
 * nvm/corepack setup never covers it: the process that actually calls `gh`
 * runs INSIDE the container, not on the host shell `sshExec` normally
 * targets. Nothing before this fix ever provisioned it there: there is no
 * Dockerfile/compose/provisioning script for `an-orchestrator`/`an-tracker`
 * anywhere in this repo (confirmed by repo-wide search) — these are
 * long-lived containers whose code gets rsynced in and restarted, never
 * rebuilt from a base image — so a fresh container (first boot, or any
 * future recreate-from-image scenario) would silently lack `gh` until
 * `workspaceMergePr` failed at runtime and someone patched the live
 * container by hand, exactly as happened before this fix existed. Runs once
 * per deploy, right after the restart command brings the container back up.
 * Never throws: a transient install hiccup (apt lock contention, momentary
 * egress blip) must not fail an otherwise-successful deploy — but a `gh`
 * that is STILL missing after the install attempt is a real, actionable gap
 * and must not be silently swallowed, so it's logged as an explicit
 * `console.warn` (same `[deploy]`-tagged convention as `sanitizeSshFailure`
 * above) rather than just discarded.
 */
async function ensureGhCli(
  cfg: DeployConfig,
  container: string,
): Promise<{ ok: boolean; detail: string }> {
  const probe = "command -v gh >/dev/null 2>&1 && echo PRESENT || echo MISSING";

  let alreadyPresent: boolean;
  try {
    const { stdout } = await sshExec(
      cfg,
      `docker exec ${container} sh -c '${probe}'`,
      30_000,
    );
    alreadyPresent = stdout.trim() === "PRESENT";
  } catch (err) {
    const detail =
      `${container}: gh presence check failed (container not running / ` +
      `docker exec unavailable) — ` +
      `${err instanceof Error ? err.message : String(err)}`;
    // eslint-disable-next-line no-console
    console.warn(`[deploy] gh CLI provisioning: ${detail}`);
    return { ok: false, detail };
  }
  if (alreadyPresent) {
    return { ok: true, detail: `${container}: gh already present (no-op)` };
  }

  try {
    await sshExec(
      cfg,
      `docker exec ${container} sh -c 'apt-get update -y && apt-get install -y gh'`,
      120_000,
    );
  } catch (err) {
    const detail = `${container}: gh install failed (${
      err instanceof Error ? err.message : String(err)
    })`;
    // eslint-disable-next-line no-console
    console.warn(`[deploy] gh CLI provisioning: ${detail}`);
    return { ok: false, detail };
  }

  const { stdout: verifyOut } = await sshExec(
    cfg,
    `docker exec ${container} sh -c '${probe}'`,
    30_000,
  ).catch(() => ({ stdout: "MISSING\n", stderr: "" }));
  if (verifyOut.trim() === "PRESENT") {
    const detail = `${container}: gh installed successfully`;
    // eslint-disable-next-line no-console
    console.log(`[deploy] gh CLI provisioning: ${detail}`);
    return { ok: true, detail };
  }
  const detail = `${container}: gh still missing after install attempt — needs manual investigation`;
  // eslint-disable-next-line no-console
  console.warn(`[deploy] gh CLI provisioning: ${detail}`);
  return { ok: false, detail };
}

/** Where the app actually gets SERVED from — see `DeployConfig.liveBasePath`. */
function liveBase(cfg: DeployConfig): string {
  return cfg.liveBasePath?.trim() ? cfg.liveBasePath : cfg.remoteBasePath;
}

function liveOutputDir(cfg: DeployConfig, app: DeployApp): string {
  return `${liveBase(cfg)}/templates/${app}/.output`;
}

/**
 * Prefix a remote command with a working Node/pnpm toolchain. `ssh user@host
 * "command"` runs a NON-interactive, NON-login shell, which on this host
 * sources neither `~/.bashrc` nor `~/.profile` — verified directly: a bare
 * `ssh ... "which node"` resolves to nothing (`PATH` is just the system
 * default, no nvm, no corepack shim), even though an interactive login shell
 * has both. Every build/install command MUST go through this — without it,
 * `pnpm`/`node` are simply not found and the whole stage fails before it
 * does anything, regardless of what the command itself is.
 *
 * `nvm install` (no version arg) reads the target repo's own `.nvmrc` once
 * `cd`'d into it and installs-or-switches accordingly — self-healing if the
 * pinned version ever changes, and a fast no-op once it's already present.
 * `corepack enable` creates a real `pnpm` shim for whichever Node version
 * `nvm install` just selected; required because `pnpm`'s own root
 * `postinstall` (scripts/prebuild-workspace-packages.ts) spawns the literal
 * `pnpm` binary via `child_process`, not through corepack, so a bare
 * `corepack pnpm` prefix on the OUTER command would not help that inner spawn
 * resolve it.
 */
function withNodeToolchain(cfg: DeployConfig, command: string): string {
  return (
    `cd '${cfg.remoteBasePath}' && ` +
    `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm install && ` +
    `corepack enable && ` +
    command
  );
}

/**
 * Backup ONE app's `.output` dir. Fails closed: a real `cp -r` failure (disk
 * full, permissions, anything) throws and propagates — it is NEVER masked by
 * a trailing `|| true`. "Source directory doesn't exist" (legitimate on a
 * first-ever deploy for this app) is its own explicit, non-error outcome,
 * distinguished by reading command STDOUT text rather than the ssh exit
 * code — the existence probe and the post-copy verification below both
 * always exit 0 (every branch ends in an `echo`), so their `&&`/`||` chains
 * are safe: unlike the copy step, nothing there is being asked to propagate
 * a real failure through the shell's exit code.
 */
async function backupApp(
  cfg: DeployConfig,
  app: DeployApp,
): Promise<"backed-up" | "no-source"> {
  // Backs up the LIVE served directory (what rollback must restore), not the
  // build checkout — the two can be different paths (see liveOutputDir).
  const dir = liveOutputDir(cfg, app);

  const { stdout: existsOut } = await sshExec(
    cfg,
    `test -d '${dir}' && echo EXISTS || echo MISSING`,
    15_000,
  );
  if (existsOut.trim() !== "EXISTS") return "no-source";

  // No `|| true` — a real `rm -rf`/`cp -r` failure here throws for real.
  await sshExec(
    cfg,
    `rm -rf '${dir}.bak' && cp -r '${dir}' '${dir}.bak'`,
    60_000,
  );

  const { stdout: verifyOut } = await sshExec(
    cfg,
    `[ -d '${dir}.bak' ] && [ -n "$(ls -A '${dir}.bak')" ] && echo BACKUP_OK || echo BACKUP_EMPTY`,
    15_000,
  );
  if (verifyOut.trim() !== "BACKUP_OK") {
    throw new Error(
      `backup verification failed for '${app}': .bak directory missing or empty after cp`,
    );
  }
  return "backed-up";
}

/**
 * Guard the destructive `git reset --hard origin/main` in the "building"
 * stage below. Unlike the `.output` directory `backupApp` snapshots, the git
 * checkout at `remoteBasePath` itself is never backed up — if it ever
 * legitimately drifts from origin/main (this project has hit exactly that: a
 * real checkout once diverged and needed manual reconciliation), a bare
 * `git reset --hard` would silently destroy that work with no recovery path.
 * Mirrors `backupApp`'s fail-loud-on-ambiguity discipline: refuse — loudly,
 * before the reset ever runs — when the checkout has uncommitted changes or
 * local commits not yet reachable from `origin/main`, rather than silently
 * resetting over them. `headSha` is passed in (not returned) so the caller
 * already has the one recoverable reference recorded even if this throws.
 */
async function assertCheckoutSafeToReset(
  cfg: DeployConfig,
  headSha: string,
): Promise<void> {
  const { stdout: statusOut } = await sshExec(
    cfg,
    `cd '${cfg.remoteBasePath}' && git status --porcelain`,
    15_000,
  );
  if (statusOut.trim().length > 0) {
    throw new Error(
      `remote checkout at '${cfg.remoteBasePath}' has uncommitted local changes ` +
        `(HEAD ${headSha}) — refusing to run 'git reset --hard' over real, ` +
        `unrecorded work. Reconcile the checkout by hand first.`,
    );
  }

  await sshExec(
    cfg,
    `cd '${cfg.remoteBasePath}' && git fetch origin main`,
    60_000,
  );
  const { stdout: aheadOut } = await sshExec(
    cfg,
    `cd '${cfg.remoteBasePath}' && git rev-list --count origin/main..HEAD`,
    15_000,
  );
  const ahead = Number.parseInt(aheadOut.trim(), 10) || 0;
  if (ahead > 0) {
    throw new Error(
      `remote checkout at '${cfg.remoteBasePath}' has ${ahead} local commit(s) ` +
        `(HEAD ${headSha}) not yet pushed to origin/main — refusing to run ` +
        `'git reset --hard' over unpushed work. Push or discard them by hand first.`,
    );
  }
}

// ── Stage-log persistence ────────────────────────────────────────────────────

async function readRun(runId: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.deployRuns)
    .where(eq(schema.deployRuns.id, runId))
    .limit(1);
  if (!row) throw new Error(`Deploy run '${runId}' not found`);
  return row;
}

function parseStageLog(raw: string): DeployStageEntry[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function setStatus(
  runId: string,
  patch: Partial<{
    status: "queued" | "running" | "succeeded" | "failed" | "rolled_back";
    stage: DeployStage;
    startedAt: string;
    completedAt: string;
    commitSha: string | null;
    backupRef: string | null;
    healthCheckResult: string | null;
    error: string | null;
  }>,
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.deployRuns)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(schema.deployRuns.id, runId));
}

/** Run one stage, recording its start/end in `stage_log` regardless of outcome. */
async function withStage<T>(
  runId: string,
  stage: DeployStage,
  cfg: DeployConfig,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = new Date().toISOString();
  const row = await readRun(runId);
  const log = parseStageLog(row.stageLog);
  log.push({ stage, startedAt });
  const db = getDb();
  await db
    .update(schema.deployRuns)
    .set({
      stage,
      stageLog: JSON.stringify(log),
      updatedAt: startedAt,
    })
    .where(eq(schema.deployRuns.id, runId));

  try {
    const result = await fn();
    // Record the stage's own result text on success too (not just on
    // failure) — a string result (every stage above returns one, e.g. the
    // "restarting" stage's gh-provisioning outcome) is genuinely useful
    // operator-facing evidence of what actually happened, not just whether
    // it happened; previously this was silently discarded on the success
    // path. Redacted with the same helper as the failure path for parity.
    const detail =
      typeof result === "string" ? redactCfgSecrets(cfg, result) : undefined;
    await completeStage(runId, stage, true, detail);
    return result;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const detail = redactCfgSecrets(cfg, raw);
    await completeStage(runId, stage, false, detail);
    throw err;
  }
}

async function completeStage(
  runId: string,
  stage: DeployStage,
  ok: boolean,
  detail?: string,
): Promise<void> {
  const row = await readRun(runId);
  const log = parseStageLog(row.stageLog);
  const idx = [...log]
    .reverse()
    .findIndex((e) => e.stage === stage && !e.completedAt);
  const completedAt = new Date().toISOString();
  if (idx !== -1) {
    const realIdx = log.length - 1 - idx;
    log[realIdx] = { ...log[realIdx], completedAt, ok, detail };
  }
  const db = getDb();
  await db
    .update(schema.deployRuns)
    .set({ stageLog: JSON.stringify(log), updatedAt: completedAt })
    .where(eq(schema.deployRuns.id, runId));
}

// ── Health check ─────────────────────────────────────────────────────────────

/**
 * Derive the deploy-version marker endpoint (`server/routes/api/
 * deploy-version.get.ts`) from the configured health-check URL's own
 * origin/base-path, rather than hardcoding a host — keeps this working for
 * whatever base path Settings → Deploy is configured with (see
 * `APP_BASE_PATH` in the "building" stage below).
 */
function deployVersionCheckUrl(healthCheckUrl: string): string {
  const base = healthCheckUrl.endsWith("/")
    ? healthCheckUrl
    : `${healthCheckUrl}/`;
  return new URL("api/deploy-version", base).toString();
}

/** Fetch the build/version marker; `null` on any non-2xx, network error, or malformed body. */
async function fetchDeployVersionMarker(
  markerUrl: string,
): Promise<string | null> {
  try {
    const res = await fetch(markerUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { commitSha?: unknown };
    return typeof body?.commitSha === "string" ? body.commitSha : null;
  } catch {
    return null;
  }
}

/**
 * Health check for gap #94: a plain `res.ok` check cannot tell a genuinely
 * new build apart from a stale CDN-cached response — this app's own
 * AGENTS.md documents that "every SSR HTML ... response is ... hard-cached at
 * the CDN for every visitor". When `expectedCommitSha` is given, a 200 alone
 * is no longer enough: the deploy is only considered verified once the
 * never-cached `deploy-version` marker (see `deployVersionCheckUrl`) actually
 * matches the commit THIS run is shipping, retrying on mismatch exactly like
 * a real connection failure so a slow-to-invalidate cache still has the
 * existing backoff window to catch up before the deploy is called failed.
 */
async function checkHealth(
  url: string,
  options: {
    attempts?: number;
    delayMs?: number;
    expectedCommitSha?: string;
  } = {},
): Promise<{ ok: boolean; status?: number; detail: string }> {
  const { attempts = 6, delayMs = 5000, expectedCommitSha } = options;
  const versionUrl = expectedCommitSha ? deployVersionCheckUrl(url) : undefined;
  let lastDetail = "not attempted";
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        if (versionUrl) {
          const marker = await fetchDeployVersionMarker(versionUrl);
          if (marker === expectedCommitSha) {
            return {
              ok: true,
              status: res.status,
              detail: `HTTP ${res.status}, build ${marker}`,
            };
          }
          lastDetail = marker
            ? `HTTP ${res.status} but still serving build '${marker}' ` +
              `(expected '${expectedCommitSha}') — likely a stale cached ` +
              `response, not yet the new build`
            : `HTTP ${res.status} but no build marker returned from ` +
              `${versionUrl} (expected '${expectedCommitSha}')`;
        } else {
          return {
            ok: true,
            status: res.status,
            detail: `HTTP ${res.status}`,
          };
        }
      } else {
        lastDetail = `HTTP ${res.status}`;
      }
    } catch (err) {
      lastDetail = err instanceof Error ? err.message : String(err);
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { ok: false, detail: lastDetail };
}

// ── The deploy job itself ────────────────────────────────────────────────────

/**
 * Runs the full backup -> build -> sync(verify-in-place) -> restart -> verify
 * pipeline, rolling back on any failure after a backup was taken. Detached
 * (fire-and-forget) from the triggering action — this app is a persistent
 * Node/Nitro process (not a serverless function that freezes on response),
 * matching V3's own long-lived reconcile-sweep precedent
 * (server/plugins/v3-reconciler.ts). `cfg` must already be resolved (see
 * loadDeployConfig's doc comment) — this function never reads secrets itself.
 */
export async function runDeployJob(
  runId: string,
  cfg: DeployConfig,
  apps: DeployApp[],
): Promise<void> {
  const db = getDb();
  await setStatus(runId, {
    status: "running",
    startedAt: new Date().toISOString(),
  });

  // Only ever true once a REAL backup exists for at least one app — verified
  // by `backupApp` (post-copy non-empty check), never assumed from a
  // no-throw ssh call. Gates whether a later failure attempts rollback.
  let backedUp = false;
  // The checkout's HEAD *before* `git reset --hard` runs (see
  // `assertCheckoutSafeToReset`) — the one recoverable reference for gap #93,
  // and reused below as the EXPECTED build marker when verifying a rollback
  // actually restored the previous build (gap #94's marker check, applied
  // symmetrically).
  let preDeployCommitSha: string | undefined;
  // The commit THIS run is deploying, captured once the build stage's
  // `git reset --hard origin/main` has landed — the expected build marker
  // `checkHealth` verifies against post-restart (gap #94).
  let commitSha: string | undefined;
  try {
    await withStage(runId, "backing-up", cfg, async () => {
      const results: string[] = [];
      for (const app of apps) {
        const outcome = await backupApp(cfg, app);
        if (outcome === "backed-up") backedUp = true;
        results.push(
          outcome === "backed-up"
            ? `${app}: backed up`
            : `${app}: no existing .output (first deploy for this app)`,
        );
      }
      await setStatus(runId, {
        backupRef: `${cfg.remoteBasePath}/templates/*/.output.bak`,
      });
      return results.join("; ");
    });

    await withStage(runId, "building", cfg, async () => {
      const results: string[] = [];
      // `pnpm install` runs ONCE here, before any app's build, not inside the
      // per-app loop below — two things depend on it that a stale
      // node_modules/dist silently skips:
      //   1. New/changed dependencies (package.json + lockfile just moved
      //      under us via git reset) actually get installed.
      //   2. Workspace packages like `@agent-native/core` get their `dist/`
      //      rebuilt (via its `postinstall` -> prebuild-workspace-packages.ts
      //      hook). `agent-native build`'s Nitro post-build step resolves
      //      `@agent-native/core`'s COMPILED dist unconditionally whenever it
      //      exists (packages/core/src/cli/deploy-build.ts has no freshness
      //      check, unlike bin/agent-native.js's own dist-vs-source check) —
      //      so without this, a core-level fix (e.g. the ACP harness package
      //      tracing fix in packages/core/src/deploy/build.ts) would silently
      //      keep running the OLD pre-fix dist forever, no matter how many
      //      times `pnpm --filter <app> build` re-runs.
      // `--frozen-lockfile` fails loud on any lockfile/package.json mismatch
      // instead of silently rewriting the lockfile on a production host.
      // `CI=true` is required too, not just nice-to-have: pnpm's own install
      // prompts an interactive "remove node_modules?" confirmation whenever
      // it decides a from-scratch reinstall is needed, and aborts outright
      // (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY) on a non-interactive ssh
      // session with no TTY to prompt on — verified by hitting this exact
      // abort during manual testing.
      //
      // Gap #93: record the checkout's current HEAD and refuse to proceed
      // (see `assertCheckoutSafeToReset`) if it has uncommitted changes or
      // unpushed local commits — `git reset --hard` below has no backup of
      // its own and would silently destroy either.
      const { stdout: headOut } = await sshExec(
        cfg,
        `cd '${cfg.remoteBasePath}' && git rev-parse HEAD`,
        15_000,
      );
      preDeployCommitSha = headOut.trim();
      await assertCheckoutSafeToReset(cfg, preDeployCommitSha);

      await sshExec(
        cfg,
        withNodeToolchain(
          cfg,
          `git fetch origin main && git checkout main && git reset --hard origin/main && CI=true pnpm install --frozen-lockfile`,
        ),
        15 * 60_000,
      );
      for (const app of apps) {
        // Gap #94: stamp the exact commit THIS build embeds into a small
        // generated constant (`server/deploy-version.generated.ts`) BEFORE
        // building, so the compiled server bundle serves it back from the
        // never-cached `/api/deploy-version` route — `checkHealth` below
        // compares this against `commitSha` to tell a genuinely new build
        // apart from a stale CDN-cached response.
        const { stdout } = await sshExec(
          cfg,
          withNodeToolchain(
            cfg,
            `SHA=$(git rev-parse HEAD) && printf 'export const DEPLOY_COMMIT_SHA = "%s";\\n' "$SHA" > templates/${app}/server/deploy-version.generated.ts && APP_BASE_PATH=/${app} VITE_APP_BASE_PATH=/${app} pnpm --filter ${app} build`,
          ),
          20 * 60_000,
        );
        results.push(stdout.slice(-2000));
      }
      const { stdout: shaOut } = await sshExec(
        cfg,
        `cd '${cfg.remoteBasePath}' && git rev-parse HEAD`,
        15_000,
      );
      commitSha = shaOut.trim();
      await setStatus(runId, { commitSha });
      return results.join("\n---\n");
    });

    await withStage(runId, "syncing", cfg, async () => {
      // Build happens in the git checkout at remoteBasePath; the running
      // containers may bind-mount a DIFFERENT directory (liveBasePath) — see
      // DeployConfig's doc comments. Copy each app's freshly-built .output
      // across before restart so the containers actually pick up the new
      // code; skipped when the two paths coincide (single-directory setups).
      // No `|| true` masking (Bug #1 precedent, see deploy-runner.spec.ts) —
      // a real copy failure here must propagate and trigger rollback, not
      // report a phantom success.
      const results: string[] = [];
      for (const app of apps) {
        const buildDir = buildOutputDir(cfg, app);
        const liveDir = liveOutputDir(cfg, app);
        if (buildDir !== liveDir) {
          await sshExec(
            cfg,
            `rm -rf '${liveDir}' && cp -r '${buildDir}' '${liveDir}'`,
            5 * 60_000,
          );
        }
        await sshExec(cfg, `test -f '${liveDir}/server/index.mjs'`, 15_000);
        results.push(`${app}: live output ready at ${liveDir}`);
      }
      return results.join("; ");
    });

    await withStage(runId, "restarting", cfg, async () => {
      const { stdout } = await sshExec(cfg, cfg.restartCommand, 60_000);
      // Runs every deploy, not just once — idempotent (check-then-install),
      // so a container that already has `gh` is a fast no-op, and a
      // container that ever loses it (redeploy from a fresh image, manual
      // rollback to a bare container, etc.) gets it re-provisioned
      // automatically instead of silently failing `workspaceMergePr` again.
      if (apps.includes("orchestrator")) {
        const gh = await ensureGhCli(cfg, containerName("orchestrator"));
        return `${stdout.slice(-1000)}\n---\ngh CLI: ${gh.detail}`;
      }
      return stdout.slice(-1000);
    });

    const health = await withStage(runId, "verifying", cfg, async () => {
      // `expectedCommitSha` is what makes this gap #94's fix rather than the
      // old bare `res.ok` check: a 200 alone no longer passes if the
      // never-cached deploy-version marker still reports the PREVIOUS build.
      const result = await checkHealth(cfg.healthCheckUrl, {
        expectedCommitSha: commitSha,
      });
      if (!result.ok) throw new Error(`health check failed: ${result.detail}`);
      return result;
    });
    await setStatus(runId, { healthCheckResult: JSON.stringify(health) });

    await setStatus(runId, {
      status: "succeeded",
      stage: "done",
      completedAt: new Date().toISOString(),
    });
  } catch (err) {
    const message = redactCfgSecrets(
      cfg,
      err instanceof Error ? err.message : String(err),
    );
    if (!backedUp) {
      // Nothing to roll back to (failed before/during backup itself).
      await setStatus(runId, {
        status: "failed",
        error: message,
        completedAt: new Date().toISOString(),
      });
      return;
    }

    try {
      await withStage(runId, "rolling-back", cfg, async () => {
        for (const app of apps) {
          const dir = liveOutputDir(cfg, app);
          await sshExec(
            cfg,
            `test -d '${dir}.bak' && rm -rf '${dir}' && mv '${dir}.bak' '${dir}'`,
            60_000,
          );
        }
        await sshExec(cfg, cfg.restartCommand, 60_000);
        // Symmetric with the forward verify above: confirm the restore
        // actually brought back the PREVIOUS build's marker, not just a 200
        // (which a stale cache could still return during the transition).
        const health = await checkHealth(cfg.healthCheckUrl, {
          attempts: 3,
          delayMs: 5000,
          expectedCommitSha: preDeployCommitSha,
        });
        return `restored previous .output for ${apps.join(", ")}; post-rollback health: ${health.ok ? "ok" : health.detail}`;
      });
      await setStatus(runId, {
        status: "rolled_back",
        error: message,
        completedAt: new Date().toISOString(),
      });
    } catch (rollbackErr) {
      const rollbackMessage = redactCfgSecrets(
        cfg,
        rollbackErr instanceof Error
          ? rollbackErr.message
          : String(rollbackErr),
      );
      await setStatus(runId, {
        status: "failed",
        error: `${message} — ROLLBACK ALSO FAILED: ${rollbackMessage}`,
        completedAt: new Date().toISOString(),
      });
    }
  }
  void db; // getDb() above establishes the connection pool for this module's queries
}

/**
 * Boot-time reconcile: a row still "running"/"queued" after a server restart
 * can never finish (its child ssh/build processes died with the old
 * process) — mirrors V3's own reconcile-on-boot discipline instead of
 * leaving the settings UI showing a permanently "running" deploy.
 */
export async function reconcileInterruptedDeployRuns(): Promise<number> {
  const db = getDb();
  const stale = await db
    .select({ id: schema.deployRuns.id })
    .from(schema.deployRuns)
    .where(eq(schema.deployRuns.status, "running"));
  const queued = await db
    .select({ id: schema.deployRuns.id })
    .from(schema.deployRuns)
    .where(eq(schema.deployRuns.status, "queued"));
  const ids = [...stale, ...queued].map((r) => r.id);
  for (const id of ids) {
    await setStatus(id, {
      status: "failed",
      error: "interrupted — server restarted mid-deploy",
      completedAt: new Date().toISOString(),
    });
  }
  return ids.length;
}
