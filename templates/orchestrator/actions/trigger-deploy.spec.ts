// Bug #3 (TOCTOU race on "one deploy at a time") + Bug #4 (needsApproval
// doesn't gate MCP/A2A/direct-HTTP callers) regression tests for
// trigger-deploy.ts. `runDeployJob`/`loadDeployConfig` are mocked — this file
// only exercises trigger-deploy's OWN logic (the caller gate, the
// active-check, and the insert-conflict → friendly-error translation), not
// the real ssh/build pipeline (covered separately by
// server/deploy/__tests__/deploy-runner.spec.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  activeRows: [] as Array<{ id: string; target: string }>,
  inserted: [] as Array<Record<string, unknown>>,
  insertShouldConflict: false,
}));

vi.mock("../server/db/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/db/index.js")>();
  return {
    ...actual,
    getDb: () => ({
      select: (_cols?: unknown) => ({
        from: (_table?: unknown) => ({
          where: (_cond?: unknown) => ({
            limit: async (_n: number) => hoisted.activeRows,
          }),
        }),
      }),
      insert: (_table?: unknown) => ({
        values: async (row: Record<string, unknown>) => {
          if (hoisted.insertShouldConflict) {
            const err = new Error(
              "UNIQUE constraint failed: orchestrator_deploy_runs.target",
            );
            (err as { code?: string }).code = "SQLITE_CONSTRAINT_UNIQUE";
            throw err;
          }
          hoisted.inserted.push(row);
        },
      }),
    }),
  };
});

vi.mock("@agent-native/core/server/request-context", () => ({
  getRequestUserEmail: () => "owner@example.com",
}));

const mockLoadDeployConfig = vi.fn();
const mockRunDeployJob = vi.fn();
vi.mock("../server/deploy/deploy-runner.js", () => ({
  loadDeployConfig: (...args: unknown[]) => mockLoadDeployConfig(...args),
  runDeployJob: (...args: unknown[]) => mockRunDeployJob(...args),
}));

import triggerDeploy from "./trigger-deploy.js";

function resetState(): void {
  hoisted.activeRows.length = 0;
  hoisted.inserted.length = 0;
  hoisted.insertShouldConflict = false;
  mockLoadDeployConfig.mockReset();
  mockLoadDeployConfig.mockResolvedValue({
    host: "203.0.113.42",
    user: "svc-deploy",
    keyPath: "/etc/agent-native/deploy_key",
    remoteBasePath: "/srv/an-checkout",
    healthCheckUrl: "http://health.internal.example/",
    restartCommand: "docker restart an-orchestrator an-tracker",
  });
  mockRunDeployJob.mockReset();
  mockRunDeployJob.mockResolvedValue(undefined);
}

describe("trigger-deploy", () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Bug #4: caller restriction ────────────────────────────────────────────

  it("succeeds for a genuine human UI call (caller: 'frontend')", async () => {
    const result = await triggerDeploy.run(
      { apps: ["orchestrator"], target: "101" },
      { caller: "frontend" },
    );

    expect(result).toMatchObject({ status: "queued" });
    expect(hoisted.inserted).toHaveLength(1);
    expect(mockRunDeployJob).toHaveBeenCalledTimes(1);
  });

  it("succeeds for the orchestrator brain's own approval-gated tool call (caller: 'tool')", async () => {
    // needsApproval:true already paused this in production-agent.ts's own
    // tool-call loop for a human Approve/Deny BEFORE run() was ever reached
    // — allowing it back in here does not reopen the hole Bug #4 is about.
    const result = await triggerDeploy.run(
      { apps: ["orchestrator"], target: "101" },
      { caller: "tool" },
    );

    expect(result).toMatchObject({ status: "queued" });
    expect(hoisted.inserted).toHaveLength(1);
  });

  it("rejects an MCP tools/call-shaped caller before touching the DB (Bug #4 regression)", async () => {
    await expect(
      triggerDeploy.run(
        { apps: ["orchestrator"], target: "101" },
        { caller: "mcp" },
      ),
    ).rejects.toThrow(/rejected caller: 'mcp'/);

    // build-server.ts's MCP tools/call handler calls entry.run() directly
    // with no approval check — the confirmed gap. The in-action gate must
    // reject BEFORE any read/write: no active-status query result consumed,
    // no row inserted, no deploy job started.
    expect(hoisted.inserted).toHaveLength(0);
    expect(mockLoadDeployConfig).not.toHaveBeenCalled();
    expect(mockRunDeployJob).not.toHaveBeenCalled();
  });

  it("rejects a bare direct-HTTP caller with no frontend tag (Bug #4 regression)", async () => {
    // action-routes.ts also calls entry.run() directly with no approval
    // check for a plain programmatic POST that never set
    // X-Agent-Native-Frontend — the second confirmed gap.
    await expect(
      triggerDeploy.run(
        { apps: ["orchestrator"], target: "101" },
        { caller: "http" },
      ),
    ).rejects.toThrow(/rejected caller: 'http'/);

    expect(hoisted.inserted).toHaveLength(0);
  });

  it("rejects when ctx/caller is entirely absent", async () => {
    await expect(
      triggerDeploy.run({ apps: ["orchestrator"], target: "101" }),
    ).rejects.toThrow(/rejected caller: 'unknown'/);

    expect(hoisted.inserted).toHaveLength(0);
  });

  // ── Bug #3: concurrency guard ──────────────────────────────────────────────

  it("rejects a second concurrent trigger that raced past the active-status check (Bug #3 regression)", async () => {
    // Simulates the exact TOCTOU window the reviewer flagged: the
    // select-active-runs check (hoisted.activeRows) sees nothing yet (the
    // racing caller's insert hasn't landed there either), but by the time
    // THIS call's own INSERT reaches the DB, the real
    // orchestrator_deploy_runs_active_target_idx partial unique index
    // (server/plugins/db.ts v24) has already recorded the other caller's row
    // — so the insert itself throws a unique-constraint violation.
    hoisted.activeRows.length = 0; // pre-insert check sees no active run
    hoisted.insertShouldConflict = true; // but the INSERT loses the race

    await expect(
      triggerDeploy.run(
        { apps: ["orchestrator"], target: "101" },
        { caller: "frontend" },
      ),
    ).rejects.toThrow(/already in progress/);

    // The friendly message must replace the raw DB error — never surface
    // "SQLITE_CONSTRAINT_UNIQUE" / raw SQL text to the caller.
    await triggerDeploy
      .run({ apps: ["orchestrator"], target: "101" }, { caller: "frontend" })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        expect(message).not.toContain("SQLITE_CONSTRAINT");
        expect(message).not.toContain("UNIQUE constraint failed");
      });

    expect(hoisted.inserted).toHaveLength(0);
    expect(mockRunDeployJob).not.toHaveBeenCalled();
  });

  it("still rejects via the fast-path active-status check when a prior run is already visibly active", async () => {
    hoisted.activeRows.push({ id: "deploy_existing", target: "101" });

    await expect(
      triggerDeploy.run(
        { apps: ["orchestrator"], target: "101" },
        { caller: "frontend" },
      ),
    ).rejects.toThrow(/already in progress \(run deploy_existing\)/);

    expect(hoisted.inserted).toHaveLength(0);
  });
});
