// V3 Reconciler Unit Tests
//
// Tests tick flow, advisory lock, 4 node types, pause/resume, fail cascade.
// Uses an in-memory mock Drizzle DB so no real Postgres is needed.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { V3Dispatcher } from "./v3-reconciler.js";

// ── Mock expression-parser (used by reconciler for loop `until`) ────────────
vi.mock("./expression-parser.js", () => ({
  evaluateExpression: vi.fn(() => false),
}));

// ── Mock v3DbExec (advisory lock) ───────────────────────────────────────────
const hoisted = vi.hoisted(() => ({
  v3DbExec: vi.fn().mockResolvedValue({ rows: [{ locked: true }] }),
}));

vi.mock("../db/v3.js", () => ({
  v3DbExec: hoisted.v3DbExec,
  getV3Db: vi.fn(),
  v3Schema: {},
}));

import { v3DbExec } from "../db/v3.js";
import { evaluateExpression } from "./expression-parser.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface MockNodeRow {
  id: string;
  runId: string;
  nodeIdInDag: string;
  type: string;
  status: string;
  iteration: number;
  fanoutIndex: number;
  currentSpawnId: string | null;
  outputArtifactId: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  error: string | null;
  ownerEmail: string;
  orgId: string | null;
}

interface MockRunRow {
  id: string;
  templateId: string | null;
  templateVersion: number | null;
  inputs: Record<string, unknown>;
  dag: unknown;
  dagVersion: number;
  status: string;
  priority: number;
  tags: unknown;
  startedAt: Date | null;
  completedAt: Date | null;
  ownerEmail: string;
  orgId: string | null;
}

// ── Mock DB Builder ──────────────────────────────────────────────────────────

function createMockDb(
  initialRun: MockRunRow,
  initialNodes: MockNodeRow[],
) {
  const runs = new Map<string, MockRunRow>();
  runs.set(initialRun.id, { ...initialRun });
  const nodes: MockNodeRow[] = initialNodes.map((n) => ({ ...n }));
  const events: Array<{
    runId: string;
    kind: string;
    payload: unknown;
  }> = [];

  let selectSeq = 0;

  const db = {
    select: (columns?: unknown) => {
      // finalizeRun uses .select({ status: v3Runs.status }) — detect by columns arg
      const isColumnSelect = columns && typeof columns === "object";
      return {
        from: (_table: unknown) => ({
          where: (_filter: unknown) => {
            selectSeq++;
            const result = (() => {
              if (isColumnSelect) {
                // finalizeRun column projection — return runs
                return Array.from(runs.values());
              }
              if (selectSeq === 1) {
                // First select is always the run fetch
                return Array.from(runs.values());
              }
              // All subsequent selects return nodes
              return nodes.filter((n) => n.runId === initialRun.id);
            })();
            // Return object with .limit() for chain support, also awaitable
            return {
              limit: (_n: number) => result,
              then: (resolve: (r: any) => any, reject?: (e: any) => any) =>
                Promise.resolve(result).then(resolve, reject),
            };
          },
        }),
      };
    },
    update: (_table: unknown) => {
      // Distinguish v3Runs from v3Nodes by checking for unique column names:
      // v3Runs has 'templateId', v3Nodes has 'nodeIdInDag'
      const isRunUpdate = !(_table as any)?.nodeIdInDag;
      return {
        set: (data: Record<string, unknown>) => ({
          where: async (_filter: unknown) => {
            const status = data.status as string | undefined;

            if (isRunUpdate) {
              // Run-level update (pause, resume, finalize)
              for (const [, run] of runs) {
                run.status = status ?? run.status;
                if (data.completedAt) {
                  run.completedAt = data.completedAt as Date;
                }
              }
            } else {
              // Node-level update
              if (data.error) {
                for (const node of nodes) {
                  if (
                    status === "skipped" &&
                    data.error === "Upstream node failed"
                  ) {
                    if (node.status === "pending") {
                      node.status = "skipped";
                      node.error = data.error as string;
                    }
                  } else if (status === "failed") {
                    node.status = "failed";
                    node.error = data.error as string;
                    node.completedAt = new Date();
                  }
                }
              } else if (data.startedAt) {
                for (const node of nodes) {
                  if (node.status === "pending") {
                    node.status = status ?? node.status;
                    node.startedAt = data.startedAt as Date;
                  }
                }
              } else if (status && !data.startedAt && !data.completedAt) {
                for (const node of nodes) {
                  if (node.status === "pending") {
                    node.status = status;
                  }
                }
              } else {
                // Node update with status + completedAt (loop/parallel resolution, node done)
                for (const node of nodes) {
                  if (node.status === "pending") {
                    node.status = status ?? node.status;
                    if (data.completedAt) node.completedAt = data.completedAt as Date;
                  }
                }
              }
            }
            return {};
          },
        }),
      };
    },
    insert: (_table: unknown) => ({
      values: async (row: Record<string, unknown>) => {
        if (row.kind && typeof row.kind === "string" && row.runId) {
          // Event row
          events.push({
            runId: row.runId as string,
            kind: row.kind as string,
            payload: row.payload,
          });
        } else if (row.nodeIdInDag) {
          // Node row (fanout child, loop body)
          nodes.push(row as unknown as MockNodeRow);
        }
        return {};
      },
    }),
  } as unknown as PostgresJsDatabase;

  // Reset select counter before each tick
  const resetSelectSeq = () => {
    selectSeq = 0;
  };

  return { db, runs, nodes, events, resetSelectSeq };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRun(overrides: Partial<MockRunRow> = {}): MockRunRow {
  return {
    id: "run-1",
    templateId: null,
    templateVersion: null,
    inputs: {},
    dag: { nodes: [] },
    dagVersion: 1,
    status: "running",
    priority: 0,
    tags: null,
    startedAt: null,
    completedAt: null,
    ownerEmail: "local@localhost",
    orgId: null,
    ...overrides,
  };
}

function makeNode(overrides: Partial<MockNodeRow> = {}): MockNodeRow {
  return {
    id: "node-1",
    runId: "run-1",
    nodeIdInDag: "a",
    type: "agent",
    status: "pending",
    iteration: 0,
    fanoutIndex: 0,
    currentSpawnId: null,
    outputArtifactId: null,
    startedAt: null,
    completedAt: null,
    error: null,
    ownerEmail: "local@localhost",
    orgId: null,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("V3Reconciler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hoisted.v3DbExec).mockResolvedValue({
      rows: [{ locked: true }],
    });
    vi.mocked(evaluateExpression).mockReturnValue(false);
  });

  // Dynamic import to pick up fresh mocks each test
  async function getReconciler() {
    const mod = await import("./v3-reconciler.js");
    return mod.V3Reconciler;
  }

  function makeDispatcher(): V3Dispatcher & {
    spawn: ReturnType<typeof vi.fn>;
  } {
    return { spawn: vi.fn().mockResolvedValue("spawn-1") } as any;
  }

  describe("tick — lock and status gates", () => {
    it("tick skips paused run", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, events } = createMockDb(
        makeRun({ status: "paused" }),
        [makeNode()],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      expect(dispatcher.spawn).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    it("tick skips completed (done) run", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, events } = createMockDb(
        makeRun({ status: "done" }),
        [makeNode({ status: "done" })],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      expect(dispatcher.spawn).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    it("tick skips failed run", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db } = createMockDb(
        makeRun({ status: "failed" }),
        [makeNode({ status: "failed", error: "OOM" })],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      expect(dispatcher.spawn).not.toHaveBeenCalled();
    });

    it("tick skips cancelled run", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db } = createMockDb(
        makeRun({ status: "cancelled" }),
        [],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      expect(dispatcher.spawn).not.toHaveBeenCalled();
    });

    it("tick bails when advisory lock is not acquired", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db } = createMockDb(makeRun(), []);

      vi.mocked(hoisted.v3DbExec).mockResolvedValue({
        rows: [{ locked: false }],
      });

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      expect(dispatcher.spawn).not.toHaveBeenCalled();
    });
  });

  describe("tick — agent node dispatch", () => {
    it("ready agent node triggers dispatcher.spawn", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db } = createMockDb(
        makeRun({
          dag: { nodes: [{ id: "a", type: "agent", deps: [] }] },
        }),
        [makeNode({ nodeIdInDag: "a", id: "node-a" })],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      expect(dispatcher.spawn).toHaveBeenCalledTimes(1);
    });

    it("skips already-terminal nodes", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db } = createMockDb(
        makeRun({
          dag: { nodes: [{ id: "a", type: "agent", deps: [] }] },
        }),
        [makeNode({ nodeIdInDag: "a", id: "node-a", status: "done" })],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      expect(dispatcher.spawn).not.toHaveBeenCalled();
    });

    it("skips running nodes", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db } = createMockDb(
        makeRun({
          dag: { nodes: [{ id: "a", type: "agent", deps: [] }] },
        }),
        [makeNode({ nodeIdInDag: "a", id: "node-a", status: "running" })],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      expect(dispatcher.spawn).not.toHaveBeenCalled();
    });

    it("skips awaiting-approval nodes", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db } = createMockDb(
        makeRun({
          dag: { nodes: [{ id: "a", type: "agent", deps: [] }] },
        }),
        [
          makeNode({
            nodeIdInDag: "a",
            id: "node-a",
            status: "awaiting-approval",
          }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      expect(dispatcher.spawn).not.toHaveBeenCalled();
    });
  });

  describe("tick — fail cascade", () => {
    it("failed node cascades skip to downstream", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, nodes, runs } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              { id: "a", type: "agent", deps: [] },
              { id: "b", type: "agent", deps: ["a"] },
            ],
          },
        }),
        [
          makeNode({
            nodeIdInDag: "a",
            id: "node-a",
            status: "failed",
            error: "boom",
          }),
          makeNode({ nodeIdInDag: "b", id: "node-b", status: "pending" }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      // Node b should have been skipped
      const nodeB = nodes.find((n) => n.nodeIdInDag === "b");
      expect(nodeB?.status).toBe("skipped");

      // Run should be finalized as failed
      const run = runs.get("run-1");
      expect(run?.status).toBe("failed");
    });
  });

  describe("tick — parallel_over fanout", () => {
    it("parallel_over expands fanout children", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, nodes } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              {
                id: "p",
                type: "parallel_over",
                deps: [],
                body: "b",
                items_from: JSON.stringify(["item1", "item2"]),
              },
            ],
          },
        }),
        [
          makeNode({
            nodeIdInDag: "p",
            id: "node-p",
            type: "parallel_over",
          }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      // Fanout children should be created
      const children = nodes.filter((n) =>
        n.nodeIdInDag.startsWith("p:["),
      );
      expect(children).toHaveLength(2);
      expect(children[0].nodeIdInDag).toBe("p:[0]");
      expect(children[1].nodeIdInDag).toBe("p:[1]");
    });
  });

  describe("tick — loop evaluation", () => {
    it("loop resolves when until expression is true", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      vi.mocked(evaluateExpression).mockReturnValue(true);

      const { db, nodes } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              {
                id: "loop1",
                type: "loop",
                deps: [],
                body: "b",
                until: "true",
                maxIterations: 10,
              },
            ],
          },
        }),
        [
          makeNode({
            nodeIdInDag: "loop1",
            id: "node-loop",
            type: "loop",
          }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      // Loop node should be marked done
      const loopNode = nodes.find((n) => n.nodeIdInDag === "loop1");
      expect(loopNode?.status).toBe("done");

      // No new body iteration should be created
      const bodyNodes = nodes.filter((n) =>
        n.nodeIdInDag.endsWith("/body"),
      );
      expect(bodyNodes).toHaveLength(0);
    });

    it("loop creates body node when until expression is false", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      vi.mocked(evaluateExpression).mockReturnValue(false);

      const { db, nodes } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              {
                id: "loop1",
                type: "loop",
                deps: [],
                body: "b",
                until: "false",
                maxIterations: 10,
              },
            ],
          },
        }),
        [
          makeNode({
            nodeIdInDag: "loop1",
            id: "node-loop",
            type: "loop",
          }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      // New body node should be created
      const bodyNodes = nodes.filter((n) =>
        n.nodeIdInDag.endsWith("/body"),
      );
      expect(bodyNodes).toHaveLength(1);
      expect(bodyNodes[0].iteration).toBe(1);
    });

    it("loop respects max_iterations", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      // until is false, but max iterations reached
      vi.mocked(evaluateExpression).mockReturnValue(false);

      const { db, nodes } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              {
                id: "loop1",
                type: "loop",
                deps: [],
                body: "b",
                until: "false",
                maxIterations: 2,
              },
            ],
          },
        }),
        [
          makeNode({
            nodeIdInDag: "loop1",
            id: "node-loop",
            type: "loop",
          }),
          makeNode({
            nodeIdInDag: "loop1/body",
            id: "body-1",
            type: "agent",
            status: "done",
            iteration: 1,
          }),
          makeNode({
            nodeIdInDag: "loop1/body",
            id: "body-2",
            type: "agent",
            status: "done",
            iteration: 2,
          }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      // Loop should be resolved (max_iterations reached)
      const loopNode = nodes.find((n) => n.nodeIdInDag === "loop1");
      expect(loopNode?.status).toBe("done");

      // No new body inserted
      const bodyNodes = nodes.filter(
        (n) => n.nodeIdInDag === "loop1/body",
      );
      expect(bodyNodes).toHaveLength(2); // only the 2 existing
    });
  });

  describe("tick — human_gate", () => {
    it("human_gate sets awaiting-approval status", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, nodes } = createMockDb(
        makeRun({
          dag: { nodes: [{ id: "hg", type: "human_gate", deps: [] }] },
        }),
        [
          makeNode({
            nodeIdInDag: "hg",
            id: "node-hg",
            type: "human_gate",
          }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      const gateNode = nodes.find((n) => n.nodeIdInDag === "hg");
      expect(gateNode?.status).toBe("awaiting-approval");
    });
  });

  describe("pause / resume", () => {
    it("pause sets status", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, runs } = createMockDb(
        makeRun({ status: "running" }),
        [],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.pause("run-1");

      const run = runs.get("run-1");
      expect(run?.status).toBe("paused");
    });

    it("resume sets status", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, runs } = createMockDb(
        makeRun({ status: "paused" }),
        [],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.resume("run-1");

      const run = runs.get("run-1");
      expect(run?.status).toBe("running");
    });
  });

  describe("run completion detection", () => {
    it("run completion detected when all nodes done", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, runs } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              { id: "a", type: "agent", deps: [] },
              { id: "b", type: "agent", deps: ["a"] },
            ],
          },
        }),
        [
          makeNode({ nodeIdInDag: "a", id: "node-a", status: "done" }),
          makeNode({ nodeIdInDag: "b", id: "node-b", status: "done" }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      // No spawns (all done)
      expect(dispatcher.spawn).not.toHaveBeenCalled();

      // Run should be finalized as done
      const run = runs.get("run-1");
      expect(run?.status).toBe("done");
    });
  });
});
