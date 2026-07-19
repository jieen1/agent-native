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

/**
 * Matches the "syncing" stage's build->live copy, NOT the "backing-up"
 * stage's dir->dir.bak copy — both are `rm -rf ... && cp -r ...`, but only
 * the backup copy's destination ends in `.bak`.
 */
function isLiveSyncCopy(cmd: string): boolean {
  return (
    cmd.startsWith("rm -rf") && cmd.includes("cp -r") && !cmd.includes(".bak")
  );
}

/** Matches the pre-reset checkout guard's dirty-working-tree probe (Bug #93). */
function isGitStatusProbe(cmd: string): boolean {
  return cmd.includes("git status --porcelain");
}

/** Matches the pre-reset checkout guard's ahead-of-origin/main count (Bug #93). */
function isAheadCountProbe(cmd: string): boolean {
  return cmd.includes("git rev-list --count origin/main..HEAD");
}

/** A clean, up-to-date checkout — the default for every test that isn't specifically exercising Bug #93. */
function cleanCheckoutBranch(
  cmd: string,
): { stdout: string; stderr: string } | null {
  if (isGitStatusProbe(cmd)) return { stdout: "", stderr: "" };
  if (isAheadCountProbe(cmd)) return { stdout: "0\n", stderr: "" };
  return null;
}

/** Matches the deploy-version marker endpoint the health check fetches (Bug #94). */
function isDeployVersionUrl(url: string): boolean {
  return url.includes("/api/deploy-version");
}

/** Matches `ensureGhCli`'s presence probe (`command -v gh ... PRESENT/MISSING`) inside a container. */
function isGhProbe(cmd: string): boolean {
  return cmd.startsWith("docker exec") && cmd.includes("command -v gh");
}

/** Matches `ensureGhCli`'s install command. */
function isGhInstall(cmd: string): boolean {
  return cmd.startsWith("docker exec") && cmd.includes("apt-get install -y gh");
}

/** A `global.fetch` mock where the base health-check URL and the deploy-version marker both report `commitSha`. */
function healthyFetchWithMarker(commitSha: string): typeof fetch {
  return vi.fn(async (url: string) => {
    if (isDeployVersionUrl(url)) {
      return { ok: true, status: 200, json: async () => ({ commitSha }) };
    }
    return { ok: true, status: 200 };
  }) as unknown as typeof fetch;
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
      const clean = cleanCheckoutBranch(cmd);
      if (clean) return clean;
      if (cmd.includes("git rev-parse HEAD"))
        return { stdout: "abc123\n", stderr: "" };
      if (isExistsProbe(cmd)) return { stdout: "EXISTS\n", stderr: "" };
      if (isBackupVerifyProbe(cmd))
        return { stdout: "BACKUP_OK\n", stderr: "" };
      return { stdout: "ok", stderr: "" };
    };
    global.fetch = healthyFetchWithMarker("abc123");

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
      const clean = cleanCheckoutBranch(cmd);
      if (clean) return clean;
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
      const clean = cleanCheckoutBranch(cmd);
      if (clean) return clean;
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
      const clean = cleanCheckoutBranch(cmd);
      if (clean) return clean;
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
      const clean = cleanCheckoutBranch(cmd);
      if (clean) return clean;
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

  it("copies build output to the live base path when they differ, and never masks a copy failure (loose-end #2 regression)", async () => {
    seedRun("deploy_split_paths");
    const SPLIT_CFG: DeployConfig = {
      ...CFG,
      remoteBasePath: "/home/claudeuser/project/agent-native",
      liveBasePath: "/home/claudeuser/agent-native",
    };
    let sawSyncCopy: string | null = null;
    hoisted.execImpl = async (cmd: string) => {
      const clean = cleanCheckoutBranch(cmd);
      if (clean) return clean;
      if (cmd.includes("git rev-parse HEAD"))
        return { stdout: "abc123\n", stderr: "" };
      if (isExistsProbe(cmd)) return { stdout: "EXISTS\n", stderr: "" };
      if (isBackupVerifyProbe(cmd))
        return { stdout: "BACKUP_OK\n", stderr: "" };
      if (isLiveSyncCopy(cmd)) {
        sawSyncCopy = cmd;
      }
      return { stdout: "ok", stderr: "" };
    };
    global.fetch = healthyFetchWithMarker("abc123");

    await runDeployJob("deploy_split_paths", SPLIT_CFG, ["orchestrator"]);

    const row = hoisted.rows.get("deploy_split_paths")!;
    expect(row.status).toBe("succeeded");
    // The sync stage must copy from the build checkout to the live
    // bind-mounted directory — without this, a build that succeeds in
    // remoteBasePath never actually reaches the containers restartCommand
    // bounces, and the deploy would silently report success shipping nothing.
    expect(sawSyncCopy).not.toBeNull();
    expect(sawSyncCopy as unknown as string).toContain(
      "/home/claudeuser/project/agent-native/templates/orchestrator/.output",
    );
    expect(sawSyncCopy as unknown as string).toContain(
      "/home/claudeuser/agent-native/templates/orchestrator/.output",
    );
    // Same no-`|| true`-masking invariant as the backup copy (Bug #1).
    expect(sawSyncCopy as unknown as string).not.toMatch(/\|\|\s*true\s*$/);
    // Backup/rollback must target the LIVE directory, not the build checkout.
    expect(
      hoisted.execCalls.some(
        (c) =>
          isExistsProbe(c) &&
          c.includes("/home/claudeuser/agent-native/templates/orchestrator"),
      ),
    ).toBe(true);
  });

  it("skips the copy when build and live base paths are the same directory", async () => {
    seedRun("deploy_same_path");
    let sawSyncCopy = false;
    hoisted.execImpl = async (cmd: string) => {
      const clean = cleanCheckoutBranch(cmd);
      if (clean) return clean;
      if (cmd.includes("git rev-parse HEAD"))
        return { stdout: "abc123\n", stderr: "" };
      if (isExistsProbe(cmd)) return { stdout: "EXISTS\n", stderr: "" };
      if (isBackupVerifyProbe(cmd))
        return { stdout: "BACKUP_OK\n", stderr: "" };
      if (isLiveSyncCopy(cmd)) sawSyncCopy = true;
      return { stdout: "ok", stderr: "" };
    };
    global.fetch = healthyFetchWithMarker("abc123");

    // CFG has no liveBasePath set — falls back to remoteBasePath, so build
    // and live directories coincide and the copy is a redundant no-op to skip.
    await runDeployJob("deploy_same_path", CFG, ["orchestrator"]);

    const row = hoisted.rows.get("deploy_same_path")!;
    expect(row.status).toBe("succeeded");
    expect(sawSyncCopy).toBe(false);
  });

  it("rolls back when the post-restart health check fails, preserving the real failure reason", async () => {
    seedRun("deploy_health_fail");
    hoisted.execImpl = async (cmd: string) => {
      const clean = cleanCheckoutBranch(cmd);
      if (clean) return clean;
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

  // ── Bug #93: the build checkout itself is never backed up, so a bare
  // `git reset --hard origin/main` has no recovery path if the checkout ever
  // legitimately drifts (this project has hit exactly that once for real).
  // Both cases below would have run the destructive reset unconditionally
  // and reported a phantom success under the OLD (pre-guard) logic.

  it("refuses to run `git reset --hard` over an ambiguous checkout with uncommitted local changes, instead of silently destroying them (Bug #93 regression)", async () => {
    seedRun("deploy_dirty_checkout");
    hoisted.execImpl = async (cmd: string) => {
      if (isGitStatusProbe(cmd))
        return { stdout: " M some/uncommitted-file.ts\n", stderr: "" };
      if (isAheadCountProbe(cmd)) return { stdout: "0\n", stderr: "" };
      if (cmd.includes("git rev-parse HEAD"))
        return { stdout: "deadbeef\n", stderr: "" };
      if (isExistsProbe(cmd)) return { stdout: "EXISTS\n", stderr: "" };
      if (isBackupVerifyProbe(cmd))
        return { stdout: "BACKUP_OK\n", stderr: "" };
      return { stdout: "ok", stderr: "" };
    };
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;

    await runDeployJob("deploy_dirty_checkout", CFG, ["orchestrator"]);

    const row = hoisted.rows.get("deploy_dirty_checkout")!;
    // Backup already succeeded before the guard fires, so this is a normal
    // rollback — but it must NEVER be "succeeded": that's exactly what the
    // old, guard-less code would have reported after silently resetting over
    // real work.
    expect(row.status).toBe("rolled_back");
    expect(row.error).toContain("uncommitted");
    expect(row.error).toContain("deadbeef");
    expect(
      hoisted.execCalls.some((c) => c.includes("git reset --hard origin/main")),
    ).toBe(false);
  });

  it("refuses to run `git reset --hard` when the checkout has local commits never pushed to origin/main (Bug #93 regression)", async () => {
    seedRun("deploy_unpushed_commits");
    hoisted.execImpl = async (cmd: string) => {
      if (isGitStatusProbe(cmd)) return { stdout: "", stderr: "" };
      if (isAheadCountProbe(cmd)) return { stdout: "2\n", stderr: "" };
      if (cmd.includes("git rev-parse HEAD"))
        return { stdout: "cafefeed\n", stderr: "" };
      if (isExistsProbe(cmd)) return { stdout: "EXISTS\n", stderr: "" };
      if (isBackupVerifyProbe(cmd))
        return { stdout: "BACKUP_OK\n", stderr: "" };
      return { stdout: "ok", stderr: "" };
    };
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;

    await runDeployJob("deploy_unpushed_commits", CFG, ["orchestrator"]);

    const row = hoisted.rows.get("deploy_unpushed_commits")!;
    expect(row.status).toBe("rolled_back");
    expect(row.error).toContain("not yet pushed");
    expect(row.error).toContain("cafefeed");
    expect(
      hoisted.execCalls.some((c) => c.includes("git reset --hard origin/main")),
    ).toBe(false);
  });

  // ── Real-host discovery (found while verifying the gh-provisioning fix
  // above): the "building" stage's own deploy-version.generated.ts marker
  // (see that file's doc comment) is a TRACKED file the pipeline deliberately
  // leaves dirty after every successful build — never reset back afterward.
  // Bug #93's guard, added above, would treat that expected leftover as real
  // uncommitted work and refuse EVERY deploy after the very first one.
  // Confirmed live: the real host's checkout was already sitting in exactly
  // this state from its last real deploy.

  it("does not refuse `git reset --hard` when the only dirty file is the expected deploy-version.generated.ts marker left by the PRIOR deploy's own build stage", async () => {
    seedRun("deploy_expected_dirty_marker");
    hoisted.execImpl = async (cmd: string) => {
      if (isGitStatusProbe(cmd))
        return {
          stdout:
            " M templates/orchestrator/server/deploy-version.generated.ts\n",
          stderr: "",
        };
      if (isAheadCountProbe(cmd)) return { stdout: "0\n", stderr: "" };
      if (cmd.includes("git rev-parse HEAD"))
        return { stdout: "abc123\n", stderr: "" };
      if (isExistsProbe(cmd)) return { stdout: "EXISTS\n", stderr: "" };
      if (isBackupVerifyProbe(cmd))
        return { stdout: "BACKUP_OK\n", stderr: "" };
      return { stdout: "ok", stderr: "" };
    };
    global.fetch = healthyFetchWithMarker("abc123");

    await runDeployJob("deploy_expected_dirty_marker", CFG, ["orchestrator"]);

    const row = hoisted.rows.get("deploy_expected_dirty_marker")!;
    expect(row.status).toBe("succeeded");
    expect(
      hoisted.execCalls.some((c) => c.includes("git reset --hard origin/main")),
    ).toBe(true);
  });

  it("still refuses `git reset --hard` when a REAL file is dirty alongside the expected marker (the exclusion must not swallow genuine unrecorded work)", async () => {
    seedRun("deploy_real_plus_expected_dirty");
    hoisted.execImpl = async (cmd: string) => {
      if (isGitStatusProbe(cmd))
        return {
          stdout:
            " M templates/orchestrator/server/deploy-version.generated.ts\n" +
            " M some/real-uncommitted-file.ts\n",
          stderr: "",
        };
      if (isAheadCountProbe(cmd)) return { stdout: "0\n", stderr: "" };
      if (cmd.includes("git rev-parse HEAD"))
        return { stdout: "deadbeef\n", stderr: "" };
      if (isExistsProbe(cmd)) return { stdout: "EXISTS\n", stderr: "" };
      if (isBackupVerifyProbe(cmd))
        return { stdout: "BACKUP_OK\n", stderr: "" };
      return { stdout: "ok", stderr: "" };
    };
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;

    await runDeployJob("deploy_real_plus_expected_dirty", CFG, [
      "orchestrator",
    ]);

    const row = hoisted.rows.get("deploy_real_plus_expected_dirty")!;
    expect(row.status).toBe("rolled_back");
    expect(row.error).toContain("uncommitted");
    expect(row.error).toContain("real-uncommitted-file.ts");
    expect(row.error).not.toContain("deploy-version.generated.ts");
    expect(
      hoisted.execCalls.some((c) => c.includes("git reset --hard origin/main")),
    ).toBe(false);
  });

  // ── Bug #94: `checkHealth` must not treat a bare `res.ok` 200 as proof the
  // NEW build is live — this app's own AGENTS.md documents SSR responses as
  // "hard-cached at the CDN for every visitor", so a stale cached 200 has to
  // be distinguishable from a genuinely fresh build via the never-cached
  // deploy-version marker.

  it("rolls back on a healthy-looking 200 that still carries the PREVIOUS build's version marker — a stale CDN-cached response, not a real success (Bug #94 regression)", async () => {
    seedRun("deploy_stale_marker");
    hoisted.execImpl = async (cmd: string) => {
      const clean = cleanCheckoutBranch(cmd);
      if (clean) return clean;
      if (cmd.includes("git rev-parse HEAD"))
        return { stdout: "new-sha-123\n", stderr: "" };
      if (isExistsProbe(cmd)) return { stdout: "EXISTS\n", stderr: "" };
      if (isBackupVerifyProbe(cmd))
        return { stdout: "BACKUP_OK\n", stderr: "" };
      return { stdout: "ok", stderr: "" };
    };
    global.fetch = vi.fn(async (url: string) => {
      if (isDeployVersionUrl(url)) {
        // The base URL 200s fine, but this never-cached marker endpoint is
        // itself (hypothetically) still fronted by a stale cache layer and
        // keeps reporting the OLD build — exactly the case a bare `res.ok`
        // check on the old code could never catch.
        return {
          ok: true,
          status: 200,
          json: async () => ({ commitSha: "old-sha-000" }),
        };
      }
      return { ok: true, status: 200 };
    }) as unknown as typeof fetch;

    await runDeployJob("deploy_stale_marker", CFG, ["orchestrator"]);

    const row = hoisted.rows.get("deploy_stale_marker")!;
    // Old logic (bare `res.ok`) would have reported "succeeded" here — this
    // regression test exists precisely because a 200 alone must not pass.
    expect(row.status).toBe("rolled_back");
    expect(row.error).toContain("health check failed");
    expect(row.error).toContain("stale cached response");
  }, 20_000);

  // ── gh CLI provisioning (production incident: `an-orchestrator` had no
  // `gh` at all until it was patched live into the running container by
  // hand). The "restarting" stage must idempotently check-then-install `gh`
  // INSIDE the orchestrator container on every real deploy so this can never
  // regress after a container loses it (fresh container, manual rollback to
  // a bare image, etc.) without needing another manual patch.

  it("skips installing gh when it is already present in the container (idempotent no-op)", async () => {
    seedRun("deploy_gh_present");
    let sawGhInstall = false;
    hoisted.execImpl = async (cmd: string) => {
      const clean = cleanCheckoutBranch(cmd);
      if (clean) return clean;
      if (cmd.includes("git rev-parse HEAD"))
        return { stdout: "abc123\n", stderr: "" };
      if (isExistsProbe(cmd)) return { stdout: "EXISTS\n", stderr: "" };
      if (isBackupVerifyProbe(cmd))
        return { stdout: "BACKUP_OK\n", stderr: "" };
      if (isGhInstall(cmd)) sawGhInstall = true;
      if (isGhProbe(cmd)) return { stdout: "PRESENT\n", stderr: "" };
      return { stdout: "ok", stderr: "" };
    };
    global.fetch = healthyFetchWithMarker("abc123");

    await runDeployJob("deploy_gh_present", CFG, ["orchestrator"]);

    const row = hoisted.rows.get("deploy_gh_present")!;
    expect(row.status).toBe("succeeded");
    expect(sawGhInstall).toBe(false);
    const log = JSON.parse(row.stageLog as string);
    const restarting = log.find(
      (e: { stage: string }) => e.stage === "restarting",
    );
    expect(restarting.detail).toContain("gh already present");
  });

  it("installs gh via apt-get when missing from the container, and verifies it afterward", async () => {
    seedRun("deploy_gh_missing_installs");
    let ghProbeCalls = 0;
    let sawGhInstall = false;
    hoisted.execImpl = async (cmd: string) => {
      const clean = cleanCheckoutBranch(cmd);
      if (clean) return clean;
      if (cmd.includes("git rev-parse HEAD"))
        return { stdout: "abc123\n", stderr: "" };
      if (isExistsProbe(cmd)) return { stdout: "EXISTS\n", stderr: "" };
      if (isBackupVerifyProbe(cmd))
        return { stdout: "BACKUP_OK\n", stderr: "" };
      if (isGhInstall(cmd)) {
        sawGhInstall = true;
        return { stdout: "ok", stderr: "" };
      }
      if (isGhProbe(cmd)) {
        ghProbeCalls += 1;
        // First probe (pre-install): missing. Second probe (post-install
        // verify): present — models a real successful `apt-get install`.
        return {
          stdout: ghProbeCalls === 1 ? "MISSING\n" : "PRESENT\n",
          stderr: "",
        };
      }
      return { stdout: "ok", stderr: "" };
    };
    global.fetch = healthyFetchWithMarker("abc123");

    await runDeployJob("deploy_gh_missing_installs", CFG, ["orchestrator"]);

    const row = hoisted.rows.get("deploy_gh_missing_installs")!;
    expect(row.status).toBe("succeeded");
    expect(sawGhInstall).toBe(true);
    expect(ghProbeCalls).toBe(2);
    const log = JSON.parse(row.stageLog as string);
    const restarting = log.find(
      (e: { stage: string }) => e.stage === "restarting",
    );
    expect(restarting.detail).toContain("gh installed successfully");
  });

  it("does not fail the deploy when the gh install attempt itself errors (transient problem, not a deploy blocker)", async () => {
    seedRun("deploy_gh_install_fails");
    hoisted.execImpl = async (cmd: string) => {
      const clean = cleanCheckoutBranch(cmd);
      if (clean) return clean;
      if (cmd.includes("git rev-parse HEAD"))
        return { stdout: "abc123\n", stderr: "" };
      if (isExistsProbe(cmd)) return { stdout: "EXISTS\n", stderr: "" };
      if (isBackupVerifyProbe(cmd))
        return { stdout: "BACKUP_OK\n", stderr: "" };
      if (isGhInstall(cmd))
        throw new Error("dpkg: lock is held by another process");
      if (isGhProbe(cmd)) return { stdout: "MISSING\n", stderr: "" };
      return { stdout: "ok", stderr: "" };
    };
    global.fetch = healthyFetchWithMarker("abc123");

    await runDeployJob("deploy_gh_install_fails", CFG, ["orchestrator"]);

    const row = hoisted.rows.get("deploy_gh_install_fails")!;
    // The deploy itself must still succeed — a transient gh-install problem
    // is not a reason to roll back an otherwise-healthy deploy.
    expect(row.status).toBe("succeeded");
    const log = JSON.parse(row.stageLog as string);
    const restarting = log.find(
      (e: { stage: string }) => e.stage === "restarting",
    );
    expect(restarting.ok).toBe(true);
    // But the gap must be visible, not silently swallowed.
    expect(restarting.detail).toContain("gh install failed");
  });

  it("surfaces a clear warning (not silence) when gh is still missing after a install attempt that itself reported success", async () => {
    seedRun("deploy_gh_still_missing");
    hoisted.execImpl = async (cmd: string) => {
      const clean = cleanCheckoutBranch(cmd);
      if (clean) return clean;
      if (cmd.includes("git rev-parse HEAD"))
        return { stdout: "abc123\n", stderr: "" };
      if (isExistsProbe(cmd)) return { stdout: "EXISTS\n", stderr: "" };
      if (isBackupVerifyProbe(cmd))
        return { stdout: "BACKUP_OK\n", stderr: "" };
      // Every probe (before AND after install) reports missing — models an
      // `apt-get install` that exits 0 but the binary still isn't resolvable
      // (e.g. wrong repo configured).
      if (isGhProbe(cmd)) return { stdout: "MISSING\n", stderr: "" };
      return { stdout: "ok", stderr: "" };
    };
    global.fetch = healthyFetchWithMarker("abc123");

    await runDeployJob("deploy_gh_still_missing", CFG, ["orchestrator"]);

    const row = hoisted.rows.get("deploy_gh_still_missing")!;
    expect(row.status).toBe("succeeded");
    const log = JSON.parse(row.stageLog as string);
    const restarting = log.find(
      (e: { stage: string }) => e.stage === "restarting",
    );
    expect(restarting.detail).toContain("still missing after install attempt");
  });

  it("never touches the orchestrator container's gh CLI on a tracker-only deploy", async () => {
    seedRun("deploy_tracker_only");
    let sawAnyGhCommand = false;
    hoisted.execImpl = async (cmd: string) => {
      const clean = cleanCheckoutBranch(cmd);
      if (clean) return clean;
      if (cmd.includes("git rev-parse HEAD"))
        return { stdout: "abc123\n", stderr: "" };
      if (isExistsProbe(cmd)) return { stdout: "EXISTS\n", stderr: "" };
      if (isBackupVerifyProbe(cmd))
        return { stdout: "BACKUP_OK\n", stderr: "" };
      if (isGhProbe(cmd) || isGhInstall(cmd)) sawAnyGhCommand = true;
      return { stdout: "ok", stderr: "" };
    };
    global.fetch = healthyFetchWithMarker("abc123");

    await runDeployJob("deploy_tracker_only", CFG, ["tracker"]);

    const row = hoisted.rows.get("deploy_tracker_only")!;
    expect(row.status).toBe("succeeded");
    expect(sawAnyGhCommand).toBe(false);
  });
});
