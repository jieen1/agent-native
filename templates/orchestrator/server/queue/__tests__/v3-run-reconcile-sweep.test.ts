// Unit tests for the V3 periodic reconcile sweep
// (server/queue/v3-run-reconcile-sweep.ts).
//
// This module's job is narrow: find v3_runs stuck at pending/running whose
// v3_nodes are ALL terminal and silent past a threshold, then hand them to
// the EXISTING reconciler via triggerTickSafe — it never reimplements
// terminal-status or finalize logic itself (see the module's own header
// comment). These tests mock the DB layer (../../db/index.js's getV3Db +
// @agent-native/core/db's isPostgres) and the reconciler entrypoint
// (../../plugins/v3-reconciler.js) so they run without a real Postgres
// instance, and assert only on this module's OWN decision logic:
//   - it no-ops when V3 Postgres isn't configured (no db call attempted)
//   - a run with any non-terminal node is left alone (still progressing)
//   - a run with zero nodes is left alone (not treated as stranded)
//   - a run whose nodes are all terminal but recently active is left alone
//     (still within the silence threshold)
//   - a run whose nodes are all terminal AND silent past the threshold gets
//     triggerTickSafe() called exactly once
//   - one run's failure never blocks the rest of the sweep
//   - env-driven interval/threshold getters parse overrides and fall back to
//     their documented defaults
//   - the exported candidate/terminal status sets are exactly what the task
//     requires (pending+running only — 'paused' excluded; done/failed/skipped)

import { beforeEach, describe, expect, it, vi } from "vitest";
import { v3Runs, v3Nodes } from "../../db/v3-schema.js";

const triggerTickSafeMock = vi.fn(async (_runId: string) => {});

vi.mock("../../plugins/v3-reconciler.js", () => ({
  triggerTickSafe: (runId: string) => triggerTickSafeMock(runId),
}));

let mockIsConfigured = true;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockDb: any = null;

vi.mock("../../db/index.js", () => ({
  getV3Db: () => mockDb,
}));

vi.mock("@agent-native/core/db", () => ({
  isPostgres: () => mockIsConfigured,
}));

type NodeRow = { status?: string; startedAt: string | null; completedAt: string | null };
/** Either a resolved row set, or `{ reject }` to simulate a DB error for that call. */
type NodeStep = NodeRow[] | { reject: unknown };

/**
 * Build a fake drizzle-shaped db that answers exactly the query sequence
 * `reconcileStrandedV3RunsOnce` is known to issue (see the source module):
 *   1. ONE `select().from(v3Runs).where(...)` → candidateRuns
 *   2. per candidate run, in order: `select().from(v3Nodes).where(...).limit(1)`
 *      → the "any non-terminal node?" probe
 *   3. only when the probe found none: `select().from(v3Nodes).where(...)`
 *      (no `.limit`) → all nodes for that run, used for the silence check
 *
 * `nodeSteps` is the flat, pre-ordered queue of node-query responses for (2)
 * and (3) across all candidate runs, in the exact order they'll be consumed.
 */
function makeMockDb(
  candidateRuns: Array<{ id: string; status: string }>,
  nodeSteps: NodeStep[],
) {
  let nodesCallIndex = 0;
  return {
    select(_cols: unknown) {
      return {
        from(table: unknown) {
          return {
            where(_cond: unknown) {
              if (table === v3Runs) {
                return Promise.resolve(candidateRuns);
              }
              if (table === v3Nodes) {
                const step = nodeSteps[nodesCallIndex] ?? [];
                nodesCallIndex += 1;
                if (!Array.isArray(step)) {
                  return Promise.reject(step.reject);
                }
                const rows = step;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const p: any = Promise.resolve(rows);
                p.limit = (n: number) => Promise.resolve(rows.slice(0, n));
                return p;
              }
              throw new Error("unexpected table passed to mock db");
            },
          };
        },
      };
    },
  };
}

beforeEach(() => {
  mockIsConfigured = true;
  mockDb = null;
  triggerTickSafeMock.mockClear();
  delete process.env.V3_RUN_RECONCILE_SWEEP_INTERVAL_MS;
  delete process.env.V3_NODES_SILENT_THRESHOLD_MS;
});

describe("reconcileStrandedV3RunsOnce", () => {
  it("returns [] immediately when V3 Postgres is not configured (no db call attempted)", async () => {
    mockIsConfigured = false;
    mockDb = makeMockDb([], []);
    const { reconcileStrandedV3RunsOnce } = await import("../v3-run-reconcile-sweep.js");

    const result = await reconcileStrandedV3RunsOnce();

    expect(result).toEqual([]);
    expect(triggerTickSafeMock).not.toHaveBeenCalled();
  });

  it("reconciles a running run whose nodes are ALL terminal and silent past the threshold", async () => {
    const stale = new Date(Date.now() - 60_000).toISOString(); // 60s ago > default 30s threshold
    mockDb = makeMockDb(
      [{ id: "run-1", status: "running" }],
      [
        [], // non-terminal probe: none found
        [{ status: "done", startedAt: stale, completedAt: stale }],
      ],
    );
    const { reconcileStrandedV3RunsOnce } = await import("../v3-run-reconcile-sweep.js");

    const result = await reconcileStrandedV3RunsOnce();

    expect(result).toEqual(["run-1"]);
    expect(triggerTickSafeMock).toHaveBeenCalledTimes(1);
    expect(triggerTickSafeMock).toHaveBeenCalledWith("run-1");
  });

  it("leaves a run alone when it still has a non-terminal node (still progressing)", async () => {
    mockDb = makeMockDb(
      [{ id: "run-2", status: "running" }],
      [
        [{ status: "running", startedAt: null, completedAt: null }], // non-terminal probe: found one → short-circuit, no 2nd query issued
      ],
    );
    const { reconcileStrandedV3RunsOnce } = await import("../v3-run-reconcile-sweep.js");

    const result = await reconcileStrandedV3RunsOnce();

    expect(result).toEqual([]);
    expect(triggerTickSafeMock).not.toHaveBeenCalled();
  });

  it("leaves a zero-node run alone (not treated as stranded)", async () => {
    mockDb = makeMockDb(
      [{ id: "run-3", status: "pending" }],
      [
        [], // non-terminal probe: none found (there are no nodes at all)
        [], // all-nodes fetch: empty → no timestamp to judge silence from → skip
      ],
    );
    const { reconcileStrandedV3RunsOnce } = await import("../v3-run-reconcile-sweep.js");

    const result = await reconcileStrandedV3RunsOnce();

    expect(result).toEqual([]);
    expect(triggerTickSafeMock).not.toHaveBeenCalled();
  });

  it("leaves a run alone when all nodes are terminal but activity is still within the silence threshold", async () => {
    const recent = new Date(Date.now() - 1_000).toISOString(); // 1s ago < 30s default
    mockDb = makeMockDb(
      [{ id: "run-4", status: "running" }],
      [
        [],
        [{ status: "done", startedAt: recent, completedAt: recent }],
      ],
    );
    const { reconcileStrandedV3RunsOnce } = await import("../v3-run-reconcile-sweep.js");

    const result = await reconcileStrandedV3RunsOnce();

    expect(result).toEqual([]);
    expect(triggerTickSafeMock).not.toHaveBeenCalled();
  });

  it("one run's failure never blocks the rest of the sweep", async () => {
    const stale = new Date(Date.now() - 60_000).toISOString();
    mockDb = makeMockDb(
      [
        { id: "run-bad", status: "running" },
        { id: "run-good", status: "running" },
      ],
      [
        [], // run-bad: non-terminal probe → none found
        { reject: new Error("boom") }, // run-bad: all-nodes fetch → simulated DB error
        [], // run-good: non-terminal probe → none found
        [{ status: "done", startedAt: stale, completedAt: stale }], // run-good: all-nodes fetch
      ],
    );
    const { reconcileStrandedV3RunsOnce } = await import("../v3-run-reconcile-sweep.js");

    const result = await reconcileStrandedV3RunsOnce();

    expect(result).toEqual(["run-good"]);
    expect(triggerTickSafeMock).toHaveBeenCalledTimes(1);
    expect(triggerTickSafeMock).toHaveBeenCalledWith("run-good");
  });
});

describe("sweep candidate/terminal status sets", () => {
  it("CANDIDATE_RUN_STATUSES is exactly pending + running ('paused' excluded)", async () => {
    const { CANDIDATE_RUN_STATUSES } = await import("../v3-run-reconcile-sweep.js");
    expect([...CANDIDATE_RUN_STATUSES].sort()).toEqual(["pending", "running"]);
  });

  it("TERMINAL_NODE_STATUSES mirrors the reconciler's TERMINAL_STATUSES (done/failed/skipped)", async () => {
    const { TERMINAL_NODE_STATUSES } = await import("../v3-run-reconcile-sweep.js");
    expect([...TERMINAL_NODE_STATUSES].sort()).toEqual(["done", "failed", "skipped"]);
  });
});

describe("defaultSweepIntervalMs", () => {
  it("defaults to 90000ms when V3_RUN_RECONCILE_SWEEP_INTERVAL_MS is unset", async () => {
    const { defaultSweepIntervalMs } = await import("../v3-run-reconcile-sweep.js");
    expect(defaultSweepIntervalMs()).toBe(90_000);
  });

  it("honors a valid override within the 60-120s window", async () => {
    process.env.V3_RUN_RECONCILE_SWEEP_INTERVAL_MS = "75000";
    const { defaultSweepIntervalMs } = await import("../v3-run-reconcile-sweep.js");
    expect(defaultSweepIntervalMs()).toBe(75_000);
  });

  it("falls back to the default for a non-numeric override", async () => {
    process.env.V3_RUN_RECONCILE_SWEEP_INTERVAL_MS = "not-a-number";
    const { defaultSweepIntervalMs } = await import("../v3-run-reconcile-sweep.js");
    expect(defaultSweepIntervalMs()).toBe(90_000);
  });
});

describe("defaultNodesSilentThresholdMs", () => {
  it("defaults to 30000ms when V3_NODES_SILENT_THRESHOLD_MS is unset", async () => {
    const { defaultNodesSilentThresholdMs } = await import("../v3-run-reconcile-sweep.js");
    expect(defaultNodesSilentThresholdMs()).toBe(30_000);
  });

  it("honors a valid override", async () => {
    process.env.V3_NODES_SILENT_THRESHOLD_MS = "45000";
    const { defaultNodesSilentThresholdMs } = await import("../v3-run-reconcile-sweep.js");
    expect(defaultNodesSilentThresholdMs()).toBe(45_000);
  });
});
