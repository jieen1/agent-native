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
   * Directory on the deploy host holding a git checkout of THIS SAME
   * monorepo — each app's build lives at `<remoteBasePath>/templates/<app>`,
   * mirroring this repo's own layout (the deploy host is assumed to be a
   * checkout of the same repo, per docs/agent-native-alignment-audit.md §5:
   * "以 main 为准，101 的 orchestrator/tracker .output 从 main 重建部署").
   */
  remoteBasePath: string;
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
  const [host, user, keyPath, remoteBasePath, healthCheckUrl, restartCommand] =
    await Promise.all([
      resolveSecret("DEPLOY_SSH_HOST"),
      resolveSecret("DEPLOY_SSH_USER"),
      resolveSecret("DEPLOY_SSH_KEY_PATH"),
      resolveSecret("DEPLOY_REMOTE_BASE_PATH"),
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

function outputDir(cfg: DeployConfig, app: DeployApp): string {
  return `${cfg.remoteBasePath}/templates/${app}/.output`;
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
  const dir = outputDir(cfg, app);

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
    await completeStage(runId, stage, true);
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

async function checkHealth(
  url: string,
  attempts = 6,
  delayMs = 5000,
): Promise<{ ok: boolean; status?: number; detail: string }> {
  let lastDetail = "not attempted";
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        return { ok: true, status: res.status, detail: `HTTP ${res.status}` };
      }
      lastDetail = `HTTP ${res.status}`;
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
      await sshExec(
        cfg,
        withNodeToolchain(
          cfg,
          `git fetch origin main && git checkout main && git reset --hard origin/main && CI=true pnpm install --frozen-lockfile`,
        ),
        15 * 60_000,
      );
      for (const app of apps) {
        const { stdout } = await sshExec(
          cfg,
          withNodeToolchain(
            cfg,
            `APP_BASE_PATH=/${app} VITE_APP_BASE_PATH=/${app} pnpm --filter ${app} build`,
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
      await setStatus(runId, { commitSha: shaOut.trim() });
      return results.join("\n---\n");
    });

    await withStage(runId, "syncing", cfg, async () => {
      // Build happens in place on the deploy host (see DeployConfig doc
      // comment) — there is no separate artifact transfer today, since 101 is
      // the only real target and it IS the build host. This stage verifies
      // the freshly-built server bundle actually exists before restart, so a
      // silent build failure never reaches "restarting".
      for (const app of apps) {
        await sshExec(
          cfg,
          `test -f '${outputDir(cfg, app)}/server/index.mjs'`,
          15_000,
        );
      }
      return `verified build output for ${apps.join(", ")}`;
    });

    await withStage(runId, "restarting", cfg, async () => {
      const { stdout } = await sshExec(cfg, cfg.restartCommand, 60_000);
      return stdout.slice(-1000);
    });

    const health = await withStage(runId, "verifying", cfg, async () => {
      const result = await checkHealth(cfg.healthCheckUrl);
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
          const dir = outputDir(cfg, app);
          await sshExec(
            cfg,
            `test -d '${dir}.bak' && rm -rf '${dir}' && mv '${dir}.bak' '${dir}'`,
            60_000,
          );
        }
        await sshExec(cfg, cfg.restartCommand, 60_000);
        const health = await checkHealth(cfg.healthCheckUrl, 3, 5000);
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
