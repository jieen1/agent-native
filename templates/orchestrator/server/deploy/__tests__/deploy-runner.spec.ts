// Real-behavior tests for the deploy job's stage sequencing and, most
// importantly, its rollback decision: a failure AFTER a backup was taken must
// roll back and restore + re-restart + re-verify; a failure BEFORE any backup
// (nothing to restore) must fail closed without attempting a rollback.
//
// child_process/fetch/db are the only things mocked — the actual stage
// orchestration, error propagation, and status transitions in
// deploy-runner.ts run for real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  execCalls: [] as string[],
  execImpl: null as unknown as (
    cmd: string,
  ) => Promise<{ stdout: string; stderr: string }>,
}));

vi.mock("node:child_process", () => ({
  execFile: (
    _file: string,
    args: string[],
    _opts: unknown,
    cb: (
      err: Error | null,
      result?: { stdout: string; stderr: string },
    ) => void,
  ) => {
    const remoteCommand = args[args.length - 1] ?? "";
    hoisted.execCalls.push(remoteCommand);
    hoisted
      .execImpl(remoteCommand)
      .then((r) => cb(null, r))
      .catch((e) => cb(e));
  },
}));

vi.mock("@agent-native/core/server", () => ({
  resolveSecret: vi.fn(),
}));

vi.mock("../../db/index.js", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            const row = [...hoisted.rows.values()][0];
            return row ? [row] : [];
          },
        }),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          const row = [...hoisted.rows.values()][0];
          if (row) Object.assign(row, patch);
        },
      }),
    }),
  }),
  schema: { deployRuns: { id: "id" } },
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

import { runDeployJob, type DeployConfig } from "../deploy-runner.js";

const CFG: DeployConfig = {
  host: "192.168.1.101",
  user: "deployuser",
  keyPath: "/fake/key",
  remoteBasePath: "/home/deployuser/agent-native",
  healthCheckUrl: "http://192.168.1.101/orchestrator/",
  restartCommand: "docker restart an-orchestrator",
};

function seedRun(id: string) {
  hoisted.rows.clear();
  hoisted.rows.set(id, {
    id,
    target: "101",
    apps: '["orchestrator"]',
    status: "queued",
    stage: "queued",
    stageLog: "[]",
    commitSha: null,
    backupRef: null,
    healthCheckResult: null,
    error: null,
    startedAt: null,
    completedAt: null,
    createdAt: "t0",
    updatedAt: "t0",
    triggeredBy: "a@b.com",
  });
}

/** Matches the `backupApp` existence probe (`test -d ... && echo EXISTS || echo MISSING`). */
function isExistsProbe(cmd: string): boolean {
  return cmd.includes("&& echo EXISTS ||");
}

/** Matches the `backupApp` post-copy verification probe. */
function isBackupVerifyProbe(cmd: string): boolean {
  return cmd.includes("echo BACKUP_OK ||");
}

beforeEach(() => {
  hoisted.execCalls.length = 0;
  // Health-check retries use a real setTimeout backoff between attempts
  // (production wants a real few-second wait for the container to come back
  // up) — collapse it to immediate so the retry LOGIC is still exercised for
  // real without the test wall-clock waiting ~25s per health-check failure.
  vi.stubGlobal("setTimeout", ((
    fn: (...args: unknown[]) => void,
    _ms?: number,
    ...args: unknown[]
  ) => {
    fn(...args);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runDeployJob", () => {
  it("succeeds through every real stage and records a completed, ok stage log", async () => {
    seedRun("deploy_ok");
    hoisted.execImpl = async (cmd: string) => {
      if (cmd.includes("git rev-parse HEAD"))
        return { stdout: "abc123\n", stderr: "" };
      if (isExistsProbe(cmd)) return { stdout: "EXISTS\n", stderr: "" };
      if (isBackupVerifyProbe(cmd))
        return { stdout: "BACKUP_OK\n", stderr: "" };
      return { stdout: "ok", stderr: "" };
    };
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;

    await runDeployJob("deploy_ok", CFG, ["orchestrator"]);

    const row = hoisted.rows.get("deploy_ok")!;
    expect(row.status).toBe("succeeded");
    expect(row.stage).toBe("done");
    expect(row.commitSha).toBe("abc123");
    const log = JSON.parse(row.stageLog as string);
    expect(log.map((e: { stage: string }) => e.stage)).toEqual([
      "backing-up",
      "building",
      "syncing",
      "restarting",
      "verifying",
    ]);
    expect(log.every((e: { ok?: boolean }) => e.ok === true)).toBe(true);
  });

  it("rolls back and restores the backup when a failure happens AFTER backup was taken", async () => {
    seedRun("deploy_fail_after_backup");
    hoisted.execImpl = async (cmd: string) => {
      if (isExistsProbe(cmd)) return { stdout: "EXISTS\n", stderr: "" };
      if (isBackupVerifyProbe(cmd))
        return { stdout: "BACKUP_OK\n", stderr: "" };
      if (cmd.includes("pnpm --filter"))
        throw new Error("build failed: tsc error");
      return { stdout: "ok", stderr: "" };
    };
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;

    await runDeployJob("deploy_fail_after_backup", CFG, ["orchestrator"]);

    const row = hoisted.rows.get("deploy_fail_after_backup")!;
    expect(row.status).toBe("rolled_back");
    expect(row.error).toContain("build failed");
    // Rollback must have actually restored the backup and restarted.
    expect(
      hoisted.execCalls.some((c) => c.includes("mv") && c.includes(".bak")),
    ).toBe(true);
    expect(
      hoisted.execCalls.filter((c) => c === "docker restart an-orchestrator")
        .length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("fails closed WITHOUT attempting a rollback when the failure happens before any backup exists", async () => {
    seedRun("deploy_fail_before_backup");
    hoisted.execImpl = async (cmd: string) => {
      if (isExistsProbe(cmd)) return { stdout: "EXISTS\n", stderr: "" };
      if (cmd.includes("cp -r")) throw new Error("ssh connection refused");
      return { stdout: "ok", stderr: "" };
    };
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;

    await runDeployJob("deploy_fail_before_backup", CFG, ["orchestrator"]);

    const row = hoisted.rows.get("deploy_fail_before_backup")!;
    expect(row.status).toBe("failed");
    // This synthetic error carries no configured secret, so Bug #2's
    // redaction (which only strips host/user/keyPath literals, not the
    // whole message — see the dedicated secret-leak test below) leaves it
    // intact; this assertion is about the rollback-gating decision, not
    // redaction.
    expect(row.error).toContain("connection refused");
    // The rollback restore command (`mv ...bak ...`) must never run — there is
    // nothing to roll back to since the backup stage itself failed.
    expect(
      hoisted.execCalls.some((c) => c.includes("mv") && c.includes(".bak")),
    ).toBe(false);
  });

  it("never masks a real remote backup failure behind a trailing `|| true` (Bug #1 regression)", async () => {
    seedRun("deploy_backup_fails_for_real");
    let sawCopyCommand: string | null = null;
    hoisted.execImpl = async (cmd: string) => {
      if (isExistsProbe(cmd)) return { stdout: "EXISTS\n", stderr: "" };
      if (cmd.startsWith("rm -rf") && cmd.includes("cp -r")) {
        sawCopyCommand = cmd;
        // Models a REAL remote command failure (nonzero exit from `cp -r`
        // itself — disk full/permissions/anything), NOT an ssh-transport
        // failure. Pre-fix, this exact case was invisible: the shell command
        // was `... cp -r ... || true`, so the remote shell always exited 0
        // regardless of this failure, execFileAsync never rejected, and
        // `backedUp` was set unconditionally.
        throw new Error(
          "cp: cannot create directory '.output.bak': No space left on device",
        );
      }
      return { stdout: "ok", stderr: "" };
    };
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;

    await runDeployJob("deploy_backup_fails_for_real", CFG, ["orchestrator"]);

    expect(sawCopyCommand).not.toBeNull();
    // The literal command sent for the real mutation must never end in a
    // masking `|| true` — that trailing fallback is the root cause of the
    // original bug (swallows ANY cp -r failure and reports success).
    expect(sawCopyCommand as unknown as string).not.toMatch(/\|\|\s*true\s*$/);

    const row = hoisted.rows.get("deploy_backup_fails_for_real")!;
    // A real cp -r failure must be a REAL failure — no phantom "succeeded"
    // status pretending a backup exists when it never did.
    expect(row.status).toBe("failed");
    const log = JSON.parse(row.stageLog as string);
    const backupEntry = log.find(
      (e: { stage: string }) => e.stage === "backing-up",
    );
    expect(backupEntry.ok).toBe(false);
    // Nothing to roll back to — the restore command must never run.
    expect(
      hoisted.execCalls.some((c) => c.includes("mv") && c.includes(".bak")),
    ).toBe(false);
  });

  it("never lets the ssh command line / configured secrets leak into a stored error or stage detail (Bug #2 regression)", async () => {
    seedRun("deploy_secret_leak_check");
    // A config whose host/user/keyPath share NO substring with each other or
    // with remoteBasePath — unlike the shared CFG fixture above (whose
    // remoteBasePath "/home/deployuser/agent-native" happens to embed the
    // literal user "deployuser"), so a legitimate, non-secret field like
    // `backupRef` (built from remoteBasePath) can never accidentally trip
    // this test's "no secret substring anywhere in the persisted row" check.
    const LEAK_CFG: DeployConfig = {
      host: "203.0.113.42", // TEST-NET-3 documentation address (RFC 5737)
      user: "svc-deploy-9f3",
      keyPath: "/etc/agent-native/deploy_id_ed25519",
      remoteBasePath: "/srv/an-checkout",
      healthCheckUrl: "http://health.internal.example/orchestrator/",
      restartCommand: "docker restart an-orchestrator",
    };
    // Mimics Node's REAL execFile behavior: on a nonzero exit / connection
    // failure, `err.message` embeds the full argv — including `-i <keyPath>`
    // and `<user>@<host>` — exactly what the reviewer reproduced directly.
    const rawSshError = Object.assign(
      new Error(
        `Command failed: ssh -i ${LEAK_CFG.keyPath} -o StrictHostKeyChecking=accept-new ` +
          `-o ConnectTimeout=15 -o BatchMode=yes ${LEAK_CFG.user}@${LEAK_CFG.host} 'docker restart an-orchestrator'\n` +
          `ssh: connect to host ${LEAK_CFG.host} port 22: Connection timed out`,
      ),
      { code: 255 },
    );
    hoisted.execImpl = async (cmd: string) => {
      if (isExistsProbe(cmd)) return { stdout: "EXISTS\n", stderr: "" };
      if (isBackupVerifyProbe(cmd))
        return { stdout: "BACKUP_OK\n", stderr: "" };
      if (cmd === LEAK_CFG.restartCommand) throw rawSshError;
      return { stdout: "ok", stderr: "" };
    };
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;

    await runDeployJob("deploy_secret_leak_check", LEAK_CFG, ["orchestrator"]);

    const row = hoisted.rows.get("deploy_secret_leak_check")!;
    // Serializing the whole row covers row.error AND every stageLog[].detail
    // (rollback also fails here, since the restart command always throws —
    // exercising both redaction call sites: the primary failure message and
    // the "ROLLBACK ALSO FAILED" message).
    const persisted = JSON.stringify(row);
    expect(persisted).not.toContain(LEAK_CFG.host);
    expect(persisted).not.toContain(LEAK_CFG.user);
    expect(persisted).not.toContain(LEAK_CFG.keyPath);
    // The rest of the message (genuinely useful, non-secret diagnostic
    // content) survives redaction — proves this isn't a blanket "message
    // discarded" fix that would also erase real build/remote-command errors.
    expect(row.error).toContain("[redacted]");
    expect(row.error).toContain("Connection timed out");
  });

  it("rolls back when the post-restart health check fails, preserving the real failure reason", async () => {
    seedRun("deploy_health_fail");
    hoisted.execImpl = async (cmd: string) => {
      if (isExistsProbe(cmd)) return { stdout: "EXISTS\n", stderr: "" };
      if (isBackupVerifyProbe(cmd))
        return { stdout: "BACKUP_OK\n", stderr: "" };
      return { stdout: "ok", stderr: "" };
    };
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;

    await runDeployJob("deploy_health_fail", CFG, ["orchestrator"]);

    const row = hoisted.rows.get("deploy_health_fail")!;
    expect(row.status).toBe("rolled_back");
    expect(row.error).toContain("health check failed");
  }, 20_000);
});
