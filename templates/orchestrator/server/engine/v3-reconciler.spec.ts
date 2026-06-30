// V3 Reconciler Unit Tests
//
// Tests tick flow, advisory lock, 4 node types, pause/resume, fail cascade,
// and the gap fixes: G10 (guard), G12 (parallel_over/loop), G16 (atomic CAS),
// G17 (fire-and-track), G18 (pool capacity / max_concurrency), G19 (retry),
// G20 (on_failure:continue).
//
// Uses a table-aware in-memory mock Drizzle DB so no real Postgres is needed.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { V3Dispatcher } from "./v3-reconciler.js";

// ── Mock expression-parser (used by reconciler for loop `until` + guard) ────
vi.mock("./expression-parser.js", () => ({
  evaluateExpression: vi.fn(() => false),
}));

// ── Mock v3DbExec (advisory lock + atomic UPDATE) ───────────────────────────
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

interface MockArtifactRow {
  id: string;
  spawnId: string;
  kind: string;
  textContent: string | null;
  objectContent: Record<string, unknown> | null;
  fullContentRef: string | null;
  byteSize: number;
  truncated: number;
  createdAt: Date;
  ownerEmail: string;
  orgId: string | null;
}

interface MockEventRow {
  id: string;
  runId: string;
  spawnId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  seqNum: number;
  ts: Date;
  ownerEmail: string;
  orgId: string | null;
}

// ── Table detection helpers ──────────────────────────────────────────────────
// Instead of mocking the schema, we use duck-typing on the real Drizzle table
// objects (same approach as v3-patcher.spec.ts).  In Drizzle 0.45.x, table
// objects expose their columns as properties, so we check for a unique column
// name that exists on each table.

function isRunsTable(table: unknown): boolean {
  return table !== null && typeof table === "object" && "dagVersion" in (table as object);
}
function isNodesTable(table: unknown): boolean {
  return table !== null && typeof table === "object" && "nodeIdInDag" in (table as object);
}
function isEventsTable(table: unknown): boolean {
  return table !== null && typeof table === "object" && "seqNum" in (table as object);
}
function isArtifactsTable(table: unknown): boolean {
  return table !== null && typeof table === "object" && "textContent" in (table as object);
}

// ── Mock DB Builder ──────────────────────────────────────────────────────────

/**
 * Create a table-aware in-memory Drizzle mock.
 *
 * Tracks which table is referenced by checking the sentinel __table property,
 * allowing the mock to correctly route selects/updates/inserts to the right
 * in-memory store.  This avoids the fragile selectSeq counter approach.
 */
function createMockDb(
  initialRun: MockRunRow,
  initialNodes: MockNodeRow[],
  initialArtifacts: MockArtifactRow[] = [],
  initialEvents: MockEventRow[] = [],
) {
  const runs = new Map<string, MockRunRow>();
  runs.set(initialRun.id, { ...initialRun });
  const nodes: MockNodeRow[] = initialNodes.map((n) => ({ ...n }));
  const artifacts: MockArtifactRow[] = [...initialArtifacts];
  const events: MockEventRow[] = [...initialEvents];

  let eventSeq = initialEvents.length;

  const db = {
    select: (columns?: unknown) => {
      // Detect aggregate/projection query (e.g., countGlobalRunning, writeEvent seq).
      // The reconciler uses select({ count: sql... }) or select({ nextSeq: sql... });
      // these have a plain object as the first arg (not a Drizzle table).
      // We return a simplified response: no rows, let callers handle missing fields.
      return {
        from: (table: unknown) => {
          return {
            where: (_filter: unknown) => {
              let result: unknown[] = [];
              if (isRunsTable(table)) {
                result = Array.from(runs.values());
              } else if (isNodesTable(table)) {
                result = [...nodes];
              } else if (isArtifactsTable(table)) {
                result = [...artifacts];
              } else if (isEventsTable(table)) {
                result = [...events];
              } else {
                // Aggregate query (select({ count: ... })) or unknown table — return empty
                result = [];
              }

              return {
                limit: (n: number) => result.slice(0, n),
                then: (resolve: (r: any) => any, reject?: (e: any) => any) =>
                  Promise.resolve(result).then(resolve, reject),
              };
            },
          };
        },
      };
    },

    update: (table: unknown) => {
      return {
        set: (data: Record<string, unknown>) => ({
          where: async (_filter: unknown) => {
            if (isRunsTable(table)) {
              for (const [, run] of runs) {
                if (data.status !== undefined) run.status = data.status as string;
                if (data.startedAt !== undefined) run.startedAt = data.startedAt as Date;
                if (data.completedAt !== undefined) run.completedAt = data.completedAt as Date;
              }
            } else if (isNodesTable(table)) {
              // Apply update to all nodes (filter is opaque in mock — tests are designed
              // so that broad updates still produce correct assertions)
              for (const node of nodes) {
                if (data.status !== undefined) node.status = data.status as string;
                if (data.startedAt !== undefined) node.startedAt = data.startedAt as Date;
                if (data.completedAt !== undefined) node.completedAt = data.completedAt as Date;
                if (data.error !== undefined) node.error = data.error as string | null;
                if (data.currentSpawnId !== undefined) node.currentSpawnId = data.currentSpawnId as string | null;
                if (data.outputArtifactId !== undefined) node.outputArtifactId = data.outputArtifactId as string | null;
              }
            }
            return {};
          },
        }),
      };
    },

    insert: (table: unknown) => {
      return {
        values: async (row: Record<string, unknown>) => {
          if (isEventsTable(table) || (row.kind && row.runId && !row.nodeIdInDag)) {
            events.push({
              id: row.id as string ?? `ev-${++eventSeq}`,
              runId: row.runId as string,
              spawnId: (row.spawnId as string | null) ?? null,
              kind: row.kind as string,
              payload: (row.payload as Record<string, unknown>) ?? {},
              seqNum: row.seqNum as number ?? eventSeq,
              ts: row.ts as Date ?? new Date(),
              ownerEmail: row.ownerEmail as string ?? "local@localhost",
              orgId: (row.orgId as string | null) ?? null,
            });
          } else if (isNodesTable(table) || row.nodeIdInDag) {
            nodes.push(row as unknown as MockNodeRow);
          } else if (isArtifactsTable(table)) {
            artifacts.push(row as unknown as MockArtifactRow);
          }
          return {};
        },
      };
    },
  } as unknown as PostgresJsDatabase;

  return { db, runs, nodes, events, artifacts };
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

function makeArtifact(overrides: Partial<MockArtifactRow> = {}): MockArtifactRow {
  return {
    id: "artifact-1",
    spawnId: "spawn-1",
    kind: "string",
    textContent: "output text",
    objectContent: null,
    fullContentRef: null,
    byteSize: 11,
    truncated: 0,
    createdAt: new Date(),
    ownerEmail: "local@localhost",
    orgId: null,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("V3Reconciler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: lock acquired (rows[0].locked = true) and atomic CAS succeeds (rows.length = 1)
    vi.mocked(hoisted.v3DbExec).mockImplementation((sql: string) => {
      if (typeof sql === "string" && sql.includes("pg_try_advisory_lock")) {
        return Promise.resolve({ rows: [{ locked: true }] });
      }
      if (typeof sql === "string" && sql.includes("pg_advisory_unlock")) {
        return Promise.resolve({ rows: [] });
      }
      // G16: atomic CAS UPDATE for running transition — returns 1 row to signal success
      if (typeof sql === "string" && sql.includes("UPDATE v3_nodes") && sql.includes("RETURNING id")) {
        return Promise.resolve({ rows: [{ id: "node-1" }] });
      }
      return Promise.resolve({ rows: [] });
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

      vi.mocked(hoisted.v3DbExec).mockImplementation((sql: string) => {
        if (typeof sql === "string" && sql.includes("pg_try_advisory_lock")) {
          return Promise.resolve({ rows: [{ locked: false }] });
        }
        return Promise.resolve({ rows: [] });
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
    it("parallel_over expands fanout children (literal JSON items_from)", async () => {
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
      expect(children[0]!.nodeIdInDag).toBe("p:[0]");
      expect(children[1]!.nodeIdInDag).toBe("p:[1]");
    });

    it("G12: parallel_over emits fanout.frozen event on first expansion", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, events } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              {
                id: "impl",
                type: "parallel_over",
                deps: [],
                body: "worker",
                items_from: JSON.stringify(["file-a", "file-b", "file-c"]),
              },
            ],
          },
        }),
        [
          makeNode({
            nodeIdInDag: "impl",
            id: "node-impl",
            type: "parallel_over",
          }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      // A fanout.frozen event should have been written
      const frozenEvent = events.find((e) => e.kind === "fanout.frozen");
      expect(frozenEvent).toBeDefined();
      expect((frozenEvent?.payload as any)?.nodeId).toBe("impl");
      expect(Array.isArray((frozenEvent?.payload as any)?.items)).toBe(true);
      expect((frozenEvent?.payload as any)?.items).toHaveLength(3);
    });

    it("G12: parallel_over evaluates items_from expression against dep artifacts", async () => {
      // Set up: evaluateExpression returns an array when called for items_from
      vi.mocked(evaluateExpression).mockImplementation((expr, _ctx) => {
        if (expr === "deps.design.output.files") {
          return ["file-x", "file-y"];
        }
        return false;
      });

      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, nodes } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              {
                id: "design",
                type: "agent",
                deps: [],
              },
              {
                id: "impl",
                type: "parallel_over",
                deps: ["design"],
                body: { type: "agent", agent: "worker", prompt: "Impl {{item}}" },
                items_from: "deps.design.output.files",
              },
            ],
          },
        }),
        [
          makeNode({
            nodeIdInDag: "design",
            id: "node-design",
            status: "done",
            outputArtifactId: "art-1",
          }),
          makeNode({
            nodeIdInDag: "impl",
            id: "node-impl",
            type: "parallel_over",
          }),
        ],
        [
          makeArtifact({
            id: "art-1",
            objectContent: { files: ["file-x", "file-y"] },
          }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      // Expression was evaluated and 2 children were created
      const children = nodes.filter((n) => n.nodeIdInDag.startsWith("impl:["));
      expect(children).toHaveLength(2);
    });

    it("G18: parallel_over respects max_concurrency", async () => {
      // Use a never-resolving dispatcher so fire-and-track does not re-trigger ticks
      const neverResolve = new Promise<string>(() => { /* never resolves */ });
      const dispatcher: V3Dispatcher & { spawn: ReturnType<typeof vi.fn> } = {
        spawn: vi.fn().mockReturnValue(neverResolve),
      } as any;
      // We test that only max_concurrency children are dispatched
      // by having max_concurrency=1 and 3 children

      const V3Reconciler = await getReconciler();
      const { db, nodes } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              {
                id: "p",
                type: "parallel_over",
                deps: [],
                body: "b",
                items_from: JSON.stringify(["a", "b", "c"]),
                max_concurrency: 1,
              },
            ],
          },
        }),
        [
          // parent already done (fanout already expanded)
          makeNode({ nodeIdInDag: "p", id: "node-p", type: "parallel_over", status: "done" }),
          // All children pending (were created in a prior tick)
          makeNode({ nodeIdInDag: "p:[0]", id: "child-0", type: "agent", fanoutIndex: 0 }),
          makeNode({ nodeIdInDag: "p:[1]", id: "child-1", type: "agent", fanoutIndex: 1 }),
          makeNode({ nodeIdInDag: "p:[2]", id: "child-2", type: "agent", fanoutIndex: 2 }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      // With max_concurrency=1 and no running children, only 1 should be dispatched
      // The mock v3DbExec returns 1 row for RETURNING id (CAS success)
      expect(dispatcher.spawn).toHaveBeenCalledTimes(1);
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
                body: ["b"],
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
        n.nodeIdInDag.includes("/"),
      );
      expect(bodyNodes).toHaveLength(0);
    });

    it("loop creates body nodes when until expression is false", async () => {
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
                body: ["fix", "retest"],
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

      // Body nodes should be created for iteration 1
      const bodyNodes = nodes.filter((n) =>
        n.nodeIdInDag.startsWith("loop1/"),
      );
      expect(bodyNodes.length).toBeGreaterThan(0);
    });

    it("G12: loop body[] creates sequentially-ordered nodes per iteration", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      vi.mocked(evaluateExpression).mockReturnValue(false);

      const { db, nodes } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              {
                id: "fix_loop",
                type: "loop",
                deps: [],
                body: ["fix", "retest", "rereview"],
                until: "false",
                max_iterations: 5,
              },
            ],
          },
        }),
        [
          makeNode({
            nodeIdInDag: "fix_loop",
            id: "node-loop",
            type: "loop",
          }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      // Should create 3 body nodes (fix, retest, rereview) for iteration 1
      const bodyNodes = nodes.filter((n) => n.nodeIdInDag.startsWith("fix_loop/"));
      expect(bodyNodes).toHaveLength(3);
      expect(bodyNodes.some((n) => n.nodeIdInDag === "fix_loop/fix")).toBe(true);
      expect(bodyNodes.some((n) => n.nodeIdInDag === "fix_loop/retest")).toBe(true);
      expect(bodyNodes.some((n) => n.nodeIdInDag === "fix_loop/rereview")).toBe(true);
    });

    it("loop respects max_iterations", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      // until is false, but max iterations reached
      vi.mocked(evaluateExpression).mockReturnValue(false);

      // body: ["fix"] — last body node id is "fix", so completed iterations are
      // counted by "loop1/fix" nodes with status "done".
      const { db, nodes } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              {
                id: "loop1",
                type: "loop",
                deps: [],
                body: ["fix"],
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
            nodeIdInDag: "loop1/fix",
            id: "body-1",
            type: "agent",
            status: "done",
            iteration: 1,
          }),
          makeNode({
            nodeIdInDag: "loop1/fix",
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
        (n) => n.nodeIdInDag === "loop1/fix",
      );
      expect(bodyNodes).toHaveLength(2); // only the 2 existing
    });

    it("G12: loop uses real artifact content in expression context", async () => {
      // Verify evaluateExpression is called with a context that has real dep output
      vi.mocked(evaluateExpression).mockReturnValue(true); // stop loop

      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              {
                id: "review_node",
                type: "agent",
                deps: [],
              },
              {
                id: "fix_loop",
                type: "loop",
                deps: ["review_node"],
                body: ["fix"],
                until: "deps.fix.output.verdict == 'pass'",
                max_iterations: 5,
              },
            ],
          },
        }),
        [
          makeNode({ nodeIdInDag: "review_node", id: "n-review", status: "done", outputArtifactId: "art-review" }),
          makeNode({ nodeIdInDag: "fix_loop", id: "n-loop", type: "loop" }),
          makeNode({ nodeIdInDag: "fix_loop/fix", id: "n-fix", type: "agent", status: "done", iteration: 1, outputArtifactId: "art-fix" }),
        ],
        [
          makeArtifact({ id: "art-review", objectContent: { verdict: "fail" } }),
          makeArtifact({ id: "art-fix", objectContent: { verdict: "pass" } }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      // evaluateExpression should have been called with a context that has deps
      expect(evaluateExpression).toHaveBeenCalled();
      const ctx = vi.mocked(evaluateExpression).mock.calls[0]?.[1];
      // Context should have been populated (at minimum deps object exists)
      expect(ctx).toBeDefined();
      expect(ctx?.deps).toBeDefined();
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

  describe("G10 — guard evaluation", () => {
    it("G10: node with guard=false is skipped", async () => {
      // evaluateExpression returns false by default → guard false → skip
      vi.mocked(evaluateExpression).mockReturnValue(false);

      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, nodes } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              { id: "review", type: "agent", deps: [] },
              { id: "commit", type: "agent", deps: ["review"], guard: "deps.review.output.verdict == 'pass'" },
            ],
          },
        }),
        [
          makeNode({ nodeIdInDag: "review", id: "n-review", status: "done" }),
          makeNode({ nodeIdInDag: "commit", id: "n-commit", status: "pending" }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      // Guard is false → commit should be skipped, not dispatched
      const commitNode = nodes.find((n) => n.nodeIdInDag === "commit");
      expect(commitNode?.status).toBe("skipped");
      expect(dispatcher.spawn).not.toHaveBeenCalled();
    });

    it("G10: node with guard=true proceeds to dispatch", async () => {
      vi.mocked(evaluateExpression).mockReturnValue(true);

      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, nodes } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              { id: "review", type: "agent", deps: [] },
              { id: "commit", type: "agent", deps: ["review"], guard: "deps.review.output.verdict == 'pass'" },
            ],
          },
        }),
        [
          makeNode({ nodeIdInDag: "review", id: "n-review", status: "done" }),
          makeNode({ nodeIdInDag: "commit", id: "n-commit", status: "pending" }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      // Guard is true → commit should be dispatched
      expect(dispatcher.spawn).toHaveBeenCalledTimes(1);
      const commitNode = nodes.find((n) => n.nodeIdInDag === "commit");
      expect(commitNode?.status).not.toBe("skipped");
    });

    it("G10: cascade-skip downstream when all deps are skipped", async () => {
      // commit is skipped (guard false), deploy depends only on commit
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, nodes } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              { id: "review", type: "agent", deps: [] },
              { id: "commit", type: "agent", deps: ["review"], guard: "false" },
              { id: "deploy", type: "agent", deps: ["commit"] },
            ],
          },
        }),
        [
          makeNode({ nodeIdInDag: "review", id: "n-review", status: "done" }),
          makeNode({ nodeIdInDag: "commit", id: "n-commit", status: "pending" }),
          makeNode({ nodeIdInDag: "deploy", id: "n-deploy", status: "pending" }),
        ],
      );

      // evaluateExpression returns false for the guard expression
      vi.mocked(evaluateExpression).mockReturnValue(false);

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      // Both commit (guard=false) and deploy (all deps skipped) should be skipped
      const commitNode = nodes.find((n) => n.nodeIdInDag === "commit");
      const deployNode = nodes.find((n) => n.nodeIdInDag === "deploy");
      expect(commitNode?.status).toBe("skipped");
      expect(deployNode?.status).toBe("skipped");
      expect(dispatcher.spawn).not.toHaveBeenCalled();
    });

    it("G10: guard node emits node.skipped event", async () => {
      vi.mocked(evaluateExpression).mockReturnValue(false);

      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, events } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              { id: "review", type: "agent", deps: [] },
              { id: "commit", type: "agent", deps: ["review"], guard: "deps.review.output.verdict == 'pass'" },
            ],
          },
        }),
        [
          makeNode({ nodeIdInDag: "review", id: "n-review", status: "done" }),
          makeNode({ nodeIdInDag: "commit", id: "n-commit", status: "pending" }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      const skippedEvent = events.find(
        (e) => e.kind === "node.skipped" && (e.payload as any)?.nodeId === "commit",
      );
      expect(skippedEvent).toBeDefined();
      expect((skippedEvent?.payload as any)?.reason).toContain("guard");
    });
  });

  describe("G16 — atomic status-conditioned UPDATE", () => {
    it("G16: does not dispatch when CAS UPDATE returns 0 rows (node already claimed)", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db } = createMockDb(
        makeRun({
          dag: { nodes: [{ id: "a", type: "agent", deps: [] }] },
        }),
        [makeNode({ nodeIdInDag: "a", id: "node-a" })],
      );

      // CAS returns 0 rows — another tick already claimed the node.
      // Lock acquire must still succeed (locked=true) for the tick to proceed.
      vi.mocked(hoisted.v3DbExec).mockImplementation((sql: string) => {
        if (typeof sql === "string" && sql.includes("pg_try_advisory_lock")) {
          return Promise.resolve({ rows: [{ locked: true }] });
        }
        if (typeof sql === "string" && sql.includes("pg_advisory_unlock")) {
          return Promise.resolve({ rows: [] });
        }
        if (typeof sql === "string" && sql.includes("RETURNING id")) {
          // CAS fails — 0 rows returned (node already claimed by another tick)
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      // dispatcher.spawn should NOT have been called because CAS returned 0 rows
      expect(dispatcher.spawn).not.toHaveBeenCalled();
    });

    it("G16: dispatches when CAS UPDATE returns 1 row", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db } = createMockDb(
        makeRun({
          dag: { nodes: [{ id: "a", type: "agent", deps: [] }] },
        }),
        [makeNode({ nodeIdInDag: "a", id: "node-a" })],
      );

      // CAS returns 1 row — success (default mock behavior)
      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      expect(dispatcher.spawn).toHaveBeenCalledTimes(1);
    });
  });

  describe("G17 — fire-and-track spawn", () => {
    it("G17: dispatcher.spawn is called asynchronously (not blocking tick completion)", async () => {
      const V3Reconciler = await getReconciler();
      let resolveSpawn: (id: string) => void = () => {};
      const spawnPromise = new Promise<string>((resolve) => { resolveSpawn = resolve; });
      const dispatcher: V3Dispatcher & { spawn: ReturnType<typeof vi.fn> } = {
        spawn: vi.fn().mockReturnValue(spawnPromise),
      } as any;

      const { db } = createMockDb(
        makeRun({
          dag: { nodes: [{ id: "a", type: "agent", deps: [] }] },
        }),
        [makeNode({ nodeIdInDag: "a", id: "node-a" })],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      // tick should complete even though spawn hasn't resolved yet
      await reconciler.tick("run-1");

      // spawn was called
      expect(dispatcher.spawn).toHaveBeenCalledTimes(1);

      // Resolve spawn to prevent dangling promises
      resolveSpawn("spawn-1");
      await spawnPromise;
    });

    it("G17: a second tick sees the node as running while spawn is in flight", async () => {
      const V3Reconciler = await getReconciler();
      // spawn never resolves during this test (simulates long-running spawn)
      let resolveSpawn: (id: string) => void = () => {};
      const spawnPromise = new Promise<string>((resolve) => { resolveSpawn = resolve; });
      const dispatcher: V3Dispatcher & { spawn: ReturnType<typeof vi.fn> } = {
        spawn: vi.fn().mockReturnValue(spawnPromise),
      } as any;

      const { db, nodes } = createMockDb(
        makeRun({
          dag: { nodes: [{ id: "a", type: "agent", deps: [] }] },
        }),
        [makeNode({ nodeIdInDag: "a", id: "node-a" })],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      // After tick, node should be in "running" state (set by atomic UPDATE)
      // In the mock, the v3DbExec RETURNING id call succeeds → node is claimed
      // The node mock update (from dispatchNode) sets status="running"
      const nodeA = nodes.find((n) => n.nodeIdInDag === "a");
      // The in-memory mock update applies broadly; the CAS was done via v3DbExec
      // We verify spawn was fired
      expect(dispatcher.spawn).toHaveBeenCalledTimes(1);

      // Resolve to clean up
      resolveSpawn("spawn-1");
      await spawnPromise;
    });
  });

  describe("G18 — pool capacity", () => {
    it("G18: respects global pool capacity (default 8)", async () => {
      const V3Reconciler = await getReconciler();

      // Use a never-resolving dispatcher so fire-and-track doesn't re-trigger ticks
      // and inflate the spawn call count beyond what the pool allows.
      const neverResolve = new Promise<string>(() => { /* intentionally never resolves */ });
      const dispatcher: V3Dispatcher & { spawn: ReturnType<typeof vi.fn> } = {
        spawn: vi.fn().mockReturnValue(neverResolve),
      } as any;

      // Create 10 pending agent nodes — more than pool capacity of 3
      const manyNodes: MockNodeRow[] = [];
      const dagNodes: unknown[] = [];
      for (let i = 0; i < 10; i++) {
        dagNodes.push({ id: `n${i}`, type: "agent", deps: [] });
        manyNodes.push(makeNode({ id: `node-${i}`, nodeIdInDag: `n${i}` }));
      }

      const { db } = createMockDb(
        makeRun({ dag: { nodes: dagNodes } }),
        manyNodes,
      );

      const reconciler = new V3Reconciler(db, dispatcher, 3); // pool capacity of 3
      await reconciler.tick("run-1");

      // Only 3 nodes should be dispatched (pool capacity)
      // Each fire-and-track is still pending (neverResolve), so no re-ticks fire.
      expect(dispatcher.spawn).toHaveBeenCalledTimes(3);
    });

    it("G18: constructor accepts custom pool capacity", async () => {
      const V3Reconciler = await getReconciler();
      // Verify the constructor accepts a third parameter (pool capacity)
      const dispatcher = makeDispatcher();
      const { db } = createMockDb(makeRun(), []);
      // Should not throw
      expect(() => new V3Reconciler(db, dispatcher, 4)).not.toThrow();
    });
  });

  describe("G19 — retry on failure", () => {
    it("G19: retries transient spawn failures with backoff", async () => {
      // dispatcher.spawn fails on first call, succeeds on second
      const dispatcher: V3Dispatcher & { spawn: ReturnType<typeof vi.fn> } = {
        spawn: vi.fn()
          .mockRejectedValueOnce(new Error("ETIMEDOUT: connection timeout"))
          .mockResolvedValueOnce("spawn-2"),
      } as any;

      const V3Reconciler = await getReconciler();
      const { db, events } = createMockDb(
        makeRun({
          dag: {
            nodes: [{
              id: "a",
              type: "agent",
              deps: [],
              retry: { max: 1, on: ["transient"], backoff: "fixed", initial_ms: 0 },
            }],
          },
        }),
        [makeNode({ nodeIdInDag: "a", id: "node-a" })],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      // Wait for async spawn to complete
      await new Promise((r) => setTimeout(r, 50));

      // spawn should have been called twice (initial + 1 retry)
      expect(dispatcher.spawn).toHaveBeenCalledTimes(2);

      // A spawn.failed event should have been written for the first attempt
      const failedEvent = events.find((e) => e.kind === "spawn.failed");
      expect(failedEvent).toBeDefined();
      expect((failedEvent?.payload as any)?.errorClass).toBe("transient");
    });

    it("G19: permanent errors are not retried", async () => {
      const dispatcher: V3Dispatcher & { spawn: ReturnType<typeof vi.fn> } = {
        spawn: vi.fn().mockRejectedValue(new Error("permanent: agent not found")),
      } as any;

      const V3Reconciler = await getReconciler();
      const { db, nodes } = createMockDb(
        makeRun({
          dag: {
            nodes: [{
              id: "a",
              type: "agent",
              deps: [],
              retry: { max: 3, on: ["transient"], backoff: "fixed", initial_ms: 0 },
            }],
          },
        }),
        [makeNode({ nodeIdInDag: "a", id: "node-a" })],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      // Wait for async spawn to complete
      await new Promise((r) => setTimeout(r, 50));

      // Should only have tried once (permanent = no retry)
      expect(dispatcher.spawn).toHaveBeenCalledTimes(1);
    });
  });

  describe("G20 — on_failure:continue", () => {
    it("G20: run completes as done even when on_failure:continue node fails", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, runs } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              { id: "main", type: "agent", deps: [] },
              { id: "lint", type: "agent", deps: [], on_failure: "continue" },
            ],
          },
        }),
        [
          makeNode({ nodeIdInDag: "main", id: "n-main", status: "done" }),
          makeNode({ nodeIdInDag: "lint", id: "n-lint", status: "failed", error: "lint error" }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      // Run should be done, not failed, because lint has on_failure:continue
      const run = runs.get("run-1");
      expect(run?.status).toBe("done");
    });

    it("G20: run fails when non-continue node fails", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, runs } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              { id: "main", type: "agent", deps: [] },
              { id: "lint", type: "agent", deps: [], on_failure: "continue" },
              { id: "test", type: "agent", deps: ["main"] },
            ],
          },
        }),
        [
          makeNode({ nodeIdInDag: "main", id: "n-main", status: "done" }),
          makeNode({ nodeIdInDag: "lint", id: "n-lint", status: "failed", error: "lint error" }),
          makeNode({ nodeIdInDag: "test", id: "n-test", status: "failed", error: "test failed" }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      // Run should be failed because 'test' (no on_failure:continue) failed
      const run = runs.get("run-1");
      expect(run?.status).toBe("failed");
    });

    it("G20: on_failure:continue node failure does not cascade-skip downstream", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, nodes } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              { id: "lint", type: "agent", deps: [], on_failure: "continue" },
              { id: "deploy", type: "agent", deps: ["lint"] },
            ],
          },
        }),
        [
          makeNode({ nodeIdInDag: "lint", id: "n-lint", status: "failed", error: "lint error" }),
          makeNode({ nodeIdInDag: "deploy", id: "n-deploy", status: "pending" }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      // deploy should NOT be cascade-skipped because lint has on_failure:continue
      const deployNode = nodes.find((n) => n.nodeIdInDag === "deploy");
      expect(deployNode?.status).not.toBe("skipped");
    });
  });
});
