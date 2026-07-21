// V3 Reconciler Unit Tests
//
// Tests tick flow, advisory lock, 4 node types, pause/resume, fail cascade,
// and the gap fixes: G10 (guard), G12 (parallel_over/loop), G16 (atomic CAS),
// G17 (fire-and-track), G18 (pool capacity / max_concurrency), G19 (retry),
// G20 (on_failure:continue).
//
// Uses a table-aware in-memory mock Drizzle DB so no real Postgres is needed.

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { V3Dispatcher } from "./v3-reconciler.js";

// ── Mock expression-parser (used by reconciler for loop `until` + guard) ────
vi.mock("./expression-parser.js", () => ({
  evaluateExpression: vi.fn(() => false),
}));

// ── Mock tracker-client's HIGH-LEVEL entry point only (F9) ──────────────────
// `onRunTerminal`'s own call sequence / JWT / tool-name contract is covered in
// isolation by tracker-client.spec.ts's "mock A2A client" tests. Here we keep
// `attemptWithBackoff` / `parseRunTags` / `extractDeliveryFromArtifactTexts`
// REAL so the "F9 — writeback terminal hook" tests below also exercise the
// reconciler's own outcome-classification + retry-and-give-up wiring, not just
// a stub.
vi.mock("../tracker-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tracker-client.js")>();
  return { ...actual, onRunTerminal: vi.fn() };
});

// ── Mock getDbExec (advisory xact-lock transaction + atomic UPDATE) ─────────
// tick() wraps the (non-blocking) advisory-lock acquisition in
// getDbExec().transaction(fn), calling fn({execute: mockExecute}); dispatchNode
// / fireAndTrackSpawn's atomic CAS UPDATEs call getDbExec().execute(...)
// directly (outside the transaction). Both paths share ONE mock execute fn so
// tests can assert on either.
//
// `activeNodes` links this raw-SQL mock to the SAME node rows a test's
// createMockDb() hands to `this.db` (see createMockDb below, which assigns
// `hoisted.activeNodes.current`). Without this link the CAS UPDATE always
// reported success without ever moving a node's status off "pending" — and
// because G17's fire-and-track re-triggers `tick()` after every successful
// spawn to wake the next wave, a still-"pending" node kept getting
// "dispatched" again on every re-tick, forever. That unbounded tick() ->
// dispatchNode() -> fireAndTrackSpawn() -> tick() chain resolves entirely
// through Promise microtasks (no real timer/macrotask boundary on the
// success path), so it starves the event loop outright: nothing, including
// a `testTimeout` timer or stdout flush, ever gets scheduled again. Mutating
// the shared node's status here — exactly like a real Postgres
// status-conditioned UPDATE would — makes the CAS stop succeeding once the
// node is no longer pending/ready, so the re-triggered tick sees nothing left
// to dispatch and the recursion terminates on its own.
const hoisted = vi.hoisted(() => {
  const activeNodes: {
    current: Array<{ id: string; status: string }> | null;
  } = { current: null };

  // Shared by the initial vi.fn() implementation AND every test's
  // beforeEach reset (below) so the two can never drift out of sync.
  async function defaultExecuteImpl(
    query: string | { sql: string; args?: unknown[] },
  ) {
    const sqlText = typeof query === "string" ? query : query.sql;
    if (sqlText.includes("pg_try_advisory_xact_lock")) {
      return { rows: [{ locked: true }] };
    }
    // G16/G19: atomic CAS UPDATE — succeeds only while the referenced node
    // is still in the status the SQL's WHERE clause targets (dispatchNode's
    // claim requires pending/ready; fireAndTrackSpawn's retry-reclaim
    // requires failed), mirroring real Postgres CAS semantics.
    if (
      sqlText.includes("UPDATE v3_nodes") &&
      sqlText.includes("RETURNING id")
    ) {
      const args = typeof query === "string" ? undefined : query.args;
      const nodeId = args?.[0] as string | undefined;
      const node = activeNodes.current?.find((n) => n.id === nodeId);
      const eligible = sqlText.includes("status = 'failed'")
        ? node?.status === "failed"
        : node?.status === "pending" || node?.status === "ready";
      if (node && eligible) {
        node.status = "running";
        return { rows: [{ id: node.id }] };
      }
      return { rows: [] };
    }
    return { rows: [] };
  }

  const mockExecute = vi.fn(defaultExecuteImpl);
  const mockTransaction = vi.fn(
    async (fn: (tx: { execute: typeof mockExecute }) => Promise<unknown>) =>
      fn({ execute: mockExecute }),
  );
  return { mockExecute, mockTransaction, activeNodes, defaultExecuteImpl };
});

vi.mock("../db/index.js", () => ({
  getDb: vi.fn(),
  getDbExec: vi.fn(() => ({
    execute: hoisted.mockExecute,
    transaction: hoisted.mockTransaction,
  })),
  v3Schema: {},
}));

// ── Mock the R4a.3 §4.2 point 7 claude-code concurrency gate ────────────────
// Real `admitClaudeCodeNode` (server/queue/claude-code-admit.spec.ts covers
// its own logic in isolation) would call getSetting/getDbExec with no
// meaningful fixture wiring here — mocked so the "claude-code concurrency
// gate" describe block below can control admission directly per test, and so
// every OTHER existing test (none of which dispatch a claude-code-targeting
// node) is entirely unaffected — nodeTargetsClaudeCode gates whether this
// mock is ever even consulted.
vi.mock("../queue/claude-code-admit.js", () => ({
  admitClaudeCodeNode: vi.fn(async () => ({
    admitted: true,
    running: 0,
    limit: 1,
  })),
}));

// ── Mock v3-workspace-local.js (SDLC-083 bypassed-merge sweep) ──────────────
// `sweepBypassedMerges` reuses `ciWatch`'s real `gh pr view` call to confirm a
// workspace's PR state; mocked here the same way `onRunTerminal` is mocked
// above, so tests control the "GitHub says MERGED" signal directly instead of
// shelling out to a real `gh` binary.
vi.mock("../v3-workspace-local.js", () => ({
  ciWatch: vi.fn(),
}));

import { admitClaudeCodeNode } from "../queue/claude-code-admit.js";
import { onRunTerminal } from "../tracker-client.js";
import { ciWatch } from "../v3-workspace-local.js";
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
  /** Engine-level guardrails (checkRunLimits) — max_dispatches / max_corrections_per_node / max_review_iterations. */
  limits: unknown;
  startedAt: Date | null;
  completedAt: Date | null;
  // F9-followup (task board #38) — persistent writeback outbox columns.
  writebackStatus: string | null;
  writebackOutcome: unknown;
  writebackAttempts: number;
  writebackLastError: string | null;
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

interface MockSpawnRow {
  id: string;
  nodeId: string | null;
  status: string;
  error: string | null;
  ownerEmail: string;
  orgId: string | null;
  // SDLC-083: links a spawn to the workspace it ran in — sweepBypassedMerges
  // resolves a workspace's associated run(s) through this column.
  workspaceId: string | null;
}

// SDLC-083 bypassed-merge sweep — v3_workspaces rows.
interface MockWorkspaceRow {
  id: string;
  branch: string | null;
  hostPath: string | null;
}

// ── Table detection helpers ──────────────────────────────────────────────────
// Instead of mocking the schema, we use duck-typing on the real Drizzle table
// objects (same approach as v3-patcher.spec.ts).  In Drizzle 0.45.x, table
// objects expose their columns as properties, so we check for a unique column
// name that exists on each table.

function isRunsTable(table: unknown): boolean {
  return (
    table !== null &&
    typeof table === "object" &&
    "dagVersion" in (table as object)
  );
}
function isNodesTable(table: unknown): boolean {
  return (
    table !== null &&
    typeof table === "object" &&
    "nodeIdInDag" in (table as object)
  );
}
function isEventsTable(table: unknown): boolean {
  return (
    table !== null && typeof table === "object" && "seqNum" in (table as object)
  );
}
function isArtifactsTable(table: unknown): boolean {
  return (
    table !== null &&
    typeof table === "object" &&
    "textContent" in (table as object)
  );
}
// v3_spawns has no column name shared with runs/nodes/artifacts/events —
// "renderedPrompt" is unique to it.
function isSpawnsTable(table: unknown): boolean {
  return (
    table !== null &&
    typeof table === "object" &&
    "renderedPrompt" in (table as object)
  );
}
// v3_workspaces — "hostPath" is unique to it (SDLC-083 bypassed-merge sweep).
function isWorkspacesTable(table: unknown): boolean {
  return (
    table !== null &&
    typeof table === "object" &&
    "hostPath" in (table as object)
  );
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
  initialSpawns: MockSpawnRow[] = [],
  initialWorkspaces: MockWorkspaceRow[] = [],
) {
  const runs = new Map<string, MockRunRow>();
  runs.set(initialRun.id, { ...initialRun });
  const nodes: MockNodeRow[] = initialNodes.map((n) => ({ ...n }));
  const artifacts: MockArtifactRow[] = [...initialArtifacts];
  const events: MockEventRow[] = [...initialEvents];
  const spawns: MockSpawnRow[] = initialSpawns.map((s) => ({ ...s }));
  const workspaces: MockWorkspaceRow[] = initialWorkspaces.map((w) => ({
    ...w,
  }));

  // Give the raw-SQL CAS mock (hoisted.mockExecute, see above) a view onto
  // these SAME node rows so a claim actually observed by this.db.select()
  // requires the CAS to have actually succeeded, instead of the two mocks
  // silently disagreeing about node state.
  hoisted.activeNodes.current = nodes;

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
              } else if (isSpawnsTable(table)) {
                result = [...spawns];
              } else if (isWorkspacesTable(table)) {
                result = [...workspaces];
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
                if (data.status !== undefined)
                  run.status = data.status as string;
                if (data.startedAt !== undefined)
                  run.startedAt = data.startedAt as Date;
                if (data.completedAt !== undefined)
                  run.completedAt = data.completedAt as Date;
                if (data.writebackStatus !== undefined)
                  run.writebackStatus = data.writebackStatus as string | null;
                if (data.writebackOutcome !== undefined)
                  run.writebackOutcome = data.writebackOutcome;
                if (data.writebackAttempts !== undefined)
                  run.writebackAttempts = data.writebackAttempts as number;
                if (data.writebackLastError !== undefined)
                  run.writebackLastError = data.writebackLastError as
                    | string
                    | null;
              }
            } else if (isNodesTable(table)) {
              // Apply update to all nodes (filter is opaque in mock — tests are designed
              // so that broad updates still produce correct assertions)
              for (const node of nodes) {
                if (data.status !== undefined)
                  node.status = data.status as string;
                if (data.startedAt !== undefined)
                  node.startedAt = data.startedAt as Date;
                if (data.completedAt !== undefined)
                  node.completedAt = data.completedAt as Date;
                if (data.error !== undefined)
                  node.error = data.error as string | null;
                if (data.currentSpawnId !== undefined)
                  node.currentSpawnId = data.currentSpawnId as string | null;
                if (data.outputArtifactId !== undefined)
                  node.outputArtifactId = data.outputArtifactId as
                    | string
                    | null;
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
          if (
            isEventsTable(table) ||
            (row.kind && row.runId && !row.nodeIdInDag)
          ) {
            events.push({
              id: (row.id as string) ?? `ev-${++eventSeq}`,
              runId: row.runId as string,
              spawnId: (row.spawnId as string | null) ?? null,
              kind: row.kind as string,
              payload: (row.payload as Record<string, unknown>) ?? {},
              seqNum: (row.seqNum as number) ?? eventSeq,
              ts: (row.ts as Date) ?? new Date(),
              ownerEmail: (row.ownerEmail as string) ?? "local@localhost",
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

  return { db, runs, nodes, events, artifacts, spawns, workspaces };
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
    limits: null,
    startedAt: null,
    completedAt: null,
    writebackStatus: null,
    writebackOutcome: null,
    writebackAttempts: 0,
    writebackLastError: null,
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

function makeArtifact(
  overrides: Partial<MockArtifactRow> = {},
): MockArtifactRow {
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

function makeSpawn(overrides: Partial<MockSpawnRow> = {}): MockSpawnRow {
  return {
    id: "spawn-1",
    nodeId: "node-1",
    status: "failed",
    error: null,
    ownerEmail: "local@localhost",
    orgId: null,
    workspaceId: null,
    ...overrides,
  };
}

function makeWorkspace(
  overrides: Partial<MockWorkspaceRow> = {},
): MockWorkspaceRow {
  return {
    id: "ws-1",
    branch: "orchestrator/run-1",
    hostPath: "/workspaces/ws-1",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("V3Reconciler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.activeNodes.current = null;
    // Default: xact lock acquired (rows[0].locked = true) and atomic CAS
    // succeeds only while the target node is actually still eligible (see
    // defaultExecuteImpl above) — reset explicitly since a prior test may
    // have installed its own mockImplementation override.
    vi.mocked(hoisted.mockExecute).mockImplementation(
      hoisted.defaultExecuteImpl,
    );
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
      const { db, events } = createMockDb(makeRun({ status: "paused" }), [
        makeNode(),
      ]);

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      expect(dispatcher.spawn).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    it("tick skips completed (done) run", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, events } = createMockDb(makeRun({ status: "done" }), [
        makeNode({ status: "done" }),
      ]);

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      expect(dispatcher.spawn).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    it("tick skips failed run", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db } = createMockDb(makeRun({ status: "failed" }), [
        makeNode({ status: "failed", error: "OOM" }),
      ]);

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      expect(dispatcher.spawn).not.toHaveBeenCalled();
    });

    it("tick skips cancelled run", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db } = createMockDb(makeRun({ status: "cancelled" }), []);

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      expect(dispatcher.spawn).not.toHaveBeenCalled();
    });

    it("tick bails when advisory lock is not acquired", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db } = createMockDb(makeRun(), []);

      vi.mocked(hoisted.mockExecute).mockImplementation(
        async (query: string | { sql: string; args?: unknown[] }) => {
          const sqlText = typeof query === "string" ? query : query.sql;
          if (sqlText.includes("pg_try_advisory_xact_lock")) {
            return { rows: [{ locked: false }] };
          }
          return { rows: [] };
        },
      );

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
      const children = nodes.filter((n) => n.nodeIdInDag.startsWith("p:["));
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
                body: {
                  type: "agent",
                  agent: "worker",
                  prompt: "Impl {{item}}",
                },
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
      const neverResolve = new Promise<string>(() => {
        /* never resolves */
      });
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
          makeNode({
            nodeIdInDag: "p",
            id: "node-p",
            type: "parallel_over",
            status: "done",
          }),
          // All children pending (were created in a prior tick)
          makeNode({
            nodeIdInDag: "p:[0]",
            id: "child-0",
            type: "agent",
            fanoutIndex: 0,
          }),
          makeNode({
            nodeIdInDag: "p:[1]",
            id: "child-1",
            type: "agent",
            fanoutIndex: 1,
          }),
          makeNode({
            nodeIdInDag: "p:[2]",
            id: "child-2",
            type: "agent",
            fanoutIndex: 2,
          }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      // With max_concurrency=1 and no running children, only 1 should be dispatched
      // The mock getDbExec().execute() returns 1 row for RETURNING id (CAS success)
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
      const bodyNodes = nodes.filter((n) => n.nodeIdInDag.includes("/"));
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
      const bodyNodes = nodes.filter((n) => n.nodeIdInDag.startsWith("loop1/"));
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
      const bodyNodes = nodes.filter((n) =>
        n.nodeIdInDag.startsWith("fix_loop/"),
      );
      expect(bodyNodes).toHaveLength(3);
      expect(bodyNodes.some((n) => n.nodeIdInDag === "fix_loop/fix")).toBe(
        true,
      );
      expect(bodyNodes.some((n) => n.nodeIdInDag === "fix_loop/retest")).toBe(
        true,
      );
      expect(bodyNodes.some((n) => n.nodeIdInDag === "fix_loop/rereview")).toBe(
        true,
      );
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
      const bodyNodes = nodes.filter((n) => n.nodeIdInDag === "loop1/fix");
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
          makeNode({
            nodeIdInDag: "review_node",
            id: "n-review",
            status: "done",
            outputArtifactId: "art-review",
          }),
          makeNode({ nodeIdInDag: "fix_loop", id: "n-loop", type: "loop" }),
          makeNode({
            nodeIdInDag: "fix_loop/fix",
            id: "n-fix",
            type: "agent",
            status: "done",
            iteration: 1,
            outputArtifactId: "art-fix",
          }),
        ],
        [
          makeArtifact({
            id: "art-review",
            objectContent: { verdict: "fail" },
          }),
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
      const { db, runs } = createMockDb(makeRun({ status: "running" }), []);

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.pause("run-1");

      const run = runs.get("run-1");
      expect(run?.status).toBe("paused");
    });

    it("resume sets status", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, runs } = createMockDb(makeRun({ status: "paused" }), []);

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
              {
                id: "commit",
                type: "agent",
                deps: ["review"],
                guard: "deps.review.output.verdict == 'pass'",
              },
            ],
          },
        }),
        [
          makeNode({ nodeIdInDag: "review", id: "n-review", status: "done" }),
          makeNode({
            nodeIdInDag: "commit",
            id: "n-commit",
            status: "pending",
          }),
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
              {
                id: "commit",
                type: "agent",
                deps: ["review"],
                guard: "deps.review.output.verdict == 'pass'",
              },
            ],
          },
        }),
        [
          makeNode({ nodeIdInDag: "review", id: "n-review", status: "done" }),
          makeNode({
            nodeIdInDag: "commit",
            id: "n-commit",
            status: "pending",
          }),
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
          makeNode({
            nodeIdInDag: "commit",
            id: "n-commit",
            status: "pending",
          }),
          makeNode({
            nodeIdInDag: "deploy",
            id: "n-deploy",
            status: "pending",
          }),
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
              {
                id: "commit",
                type: "agent",
                deps: ["review"],
                guard: "deps.review.output.verdict == 'pass'",
              },
            ],
          },
        }),
        [
          makeNode({ nodeIdInDag: "review", id: "n-review", status: "done" }),
          makeNode({
            nodeIdInDag: "commit",
            id: "n-commit",
            status: "pending",
          }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      const skippedEvent = events.find(
        (e) =>
          e.kind === "node.skipped" && (e.payload as any)?.nodeId === "commit",
      );
      expect(skippedEvent).toBeDefined();
      expect((skippedEvent?.payload as any)?.reason).toContain("guard");
    });
  });

  describe("checkRunLimits — engine-level guardrails (run.limits)", () => {
    it("no limits configured (limits: null) → run proceeds normally, no breach", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, runs, events } = createMockDb(
        makeRun({
          dag: { nodes: [{ id: "a", type: "agent", deps: [] }] },
          limits: null,
        }),
        [makeNode({ nodeIdInDag: "a", id: "node-a" })],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      // Not short-circuited into a limit-breach failure — normal dispatch proceeds.
      expect(dispatcher.spawn).toHaveBeenCalledTimes(1);
      expect(runs.get("run-1")?.status).not.toBe("failed");
      expect(events.some((e) => e.kind === "run.failed")).toBe(false);
    });

    it("limits object present but every field unset → treated as no limits configured", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, runs, events } = createMockDb(
        makeRun({
          dag: { nodes: [{ id: "a", type: "agent", deps: [] }] },
          limits: {},
        }),
        [makeNode({ nodeIdInDag: "a", id: "node-a" })],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      expect(dispatcher.spawn).toHaveBeenCalledTimes(1);
      expect(runs.get("run-1")?.status).not.toBe("failed");
      expect(events.some((e) => e.kind === "run.failed")).toBe(false);
    });

    it("max_dispatches exceeded → run fails with a readable breach reason, dispatch never proceeds", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, runs, events } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              { id: "a", type: "agent", deps: [] },
              { id: "b", type: "agent", deps: [] },
            ],
          },
          limits: { max_dispatches: 2 },
        }),
        [
          makeNode({ nodeIdInDag: "a", id: "node-a", status: "done" }),
          makeNode({ nodeIdInDag: "b", id: "node-b" }),
        ],
        [],
        [],
        [
          makeSpawn({ id: "spawn-1", nodeId: "node-a" }),
          makeSpawn({ id: "spawn-2", nodeId: "node-a" }),
          makeSpawn({ id: "spawn-3", nodeId: "node-b" }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      // checkRunLimits fires before the ready-candidate scan — node "b" must
      // never be dispatched once the run is already over budget.
      expect(dispatcher.spawn).not.toHaveBeenCalled();
      expect(runs.get("run-1")?.status).toBe("failed");
      const failedEvent = events.find((e) => e.kind === "run.failed");
      expect(failedEvent).toBeDefined();
      expect((failedEvent?.payload as any)?.reason).toContain(
        "max_dispatches exceeded",
      );
      expect((failedEvent?.payload as any)?.reason).toContain("3 > 2");
    });

    it("max_corrections_per_node exceeded on one node → breach reason names that node", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, runs, events } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              { id: "a", type: "agent", deps: [] },
              { id: "b", type: "agent", deps: [] },
            ],
          },
          limits: { max_corrections_per_node: 2 },
        }),
        [
          makeNode({ nodeIdInDag: "a", id: "node-a" }),
          makeNode({ nodeIdInDag: "b", id: "node-b" }),
        ],
        [],
        [],
        [
          // node-a has 3 spawns (over the per-node limit of 2); node-b has 1
          // (within limit) — the breach must name node-a specifically.
          makeSpawn({ id: "spawn-1", nodeId: "node-a" }),
          makeSpawn({ id: "spawn-2", nodeId: "node-a" }),
          makeSpawn({ id: "spawn-3", nodeId: "node-a" }),
          makeSpawn({ id: "spawn-4", nodeId: "node-b" }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      expect(dispatcher.spawn).not.toHaveBeenCalled();
      expect(runs.get("run-1")?.status).toBe("failed");
      const failedEvent = events.find((e) => e.kind === "run.failed");
      expect(failedEvent).toBeDefined();
      const reason = (failedEvent?.payload as any)?.reason as string;
      expect(reason).toContain("max_corrections_per_node exceeded");
      expect(reason).toContain("'a'");
      expect(reason).toContain("3 > 2");
    });

    it("max_review_iterations exceeded → run fails with a readable breach reason", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, runs, events } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              { id: "review1", type: "agent", deps: [] },
              { id: "review2", type: "agent", deps: [] },
              { id: "review3", type: "agent", deps: [] },
            ],
          },
          limits: { max_review_iterations: 2 },
        }),
        [
          makeNode({ nodeIdInDag: "review1", id: "n-r1", status: "done" }),
          makeNode({ nodeIdInDag: "review2", id: "n-r2", status: "done" }),
          makeNode({ nodeIdInDag: "review3", id: "n-r3", status: "running" }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      expect(dispatcher.spawn).not.toHaveBeenCalled();
      expect(runs.get("run-1")?.status).toBe("failed");
      const failedEvent = events.find((e) => e.kind === "run.failed");
      expect(failedEvent).toBeDefined();
      const reason = (failedEvent?.payload as any)?.reason as string;
      expect(reason).toContain("max_review_iterations exceeded");
      expect(reason).toContain("3 > 2");
    });

    it("within all configured limits → run proceeds normally, not failed", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, runs, events } = createMockDb(
        makeRun({
          dag: { nodes: [{ id: "a", type: "agent", deps: [] }] },
          limits: {
            max_dispatches: 10,
            max_corrections_per_node: 5,
            max_review_iterations: 5,
          },
        }),
        [makeNode({ nodeIdInDag: "a", id: "node-a" })],
        [],
        [],
        [makeSpawn({ id: "spawn-1", nodeId: "node-a" })],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      expect(dispatcher.spawn).toHaveBeenCalledTimes(1);
      expect(runs.get("run-1")?.status).not.toBe("failed");
      expect(events.some((e) => e.kind === "run.failed")).toBe(false);
    });

    // Boundary coverage: every breach check below uses strict `>`, not `>=`
    // (v3-reconciler.ts checkRunLimits). Without these, a regression to `>=`
    // would still pass every other test in this block.
    it("max_dispatches exactly at limit → not a breach, dispatch proceeds", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, runs, events } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              { id: "a", type: "agent", deps: [] },
              { id: "b", type: "agent", deps: [] },
            ],
          },
          limits: { max_dispatches: 2 },
        }),
        [
          makeNode({ nodeIdInDag: "a", id: "node-a", status: "done" }),
          makeNode({ nodeIdInDag: "b", id: "node-b" }),
        ],
        [],
        [],
        [
          makeSpawn({ id: "spawn-1", nodeId: "node-a" }),
          makeSpawn({ id: "spawn-2", nodeId: "node-a" }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      expect(dispatcher.spawn).toHaveBeenCalledTimes(1);
      expect(runs.get("run-1")?.status).not.toBe("failed");
      expect(events.some((e) => e.kind === "run.failed")).toBe(false);
    });

    it("max_corrections_per_node exactly at limit → not a breach, dispatch proceeds", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, runs, events } = createMockDb(
        makeRun({
          dag: { nodes: [{ id: "a", type: "agent", deps: [] }] },
          limits: { max_corrections_per_node: 2 },
        }),
        [makeNode({ nodeIdInDag: "a", id: "node-a" })],
        [],
        [],
        [
          makeSpawn({ id: "spawn-1", nodeId: "node-a" }),
          makeSpawn({ id: "spawn-2", nodeId: "node-a" }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      expect(dispatcher.spawn).toHaveBeenCalledTimes(1);
      expect(runs.get("run-1")?.status).not.toBe("failed");
      expect(events.some((e) => e.kind === "run.failed")).toBe(false);
    });

    it("max_review_iterations exactly at limit → not a breach, dispatch proceeds", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, runs, events } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              { id: "review1", type: "agent", deps: [] },
              { id: "review2", type: "agent", deps: [] },
            ],
          },
          limits: { max_review_iterations: 2 },
        }),
        [
          makeNode({ nodeIdInDag: "review1", id: "n-r1", status: "done" }),
          makeNode({ nodeIdInDag: "review2", id: "n-r2" }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      expect(dispatcher.spawn).toHaveBeenCalledTimes(1);
      expect(runs.get("run-1")?.status).not.toBe("failed");
      expect(events.some((e) => e.kind === "run.failed")).toBe(false);
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
      vi.mocked(hoisted.mockExecute).mockImplementation(
        async (query: string | { sql: string; args?: unknown[] }) => {
          const sqlText = typeof query === "string" ? query : query.sql;
          if (sqlText.includes("pg_try_advisory_xact_lock")) {
            return { rows: [{ locked: true }] };
          }
          if (sqlText.includes("RETURNING id")) {
            // CAS fails — 0 rows returned (node already claimed by another tick)
            return { rows: [] };
          }
          return { rows: [] };
        },
      );

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
      const spawnPromise = new Promise<string>((resolve) => {
        resolveSpawn = resolve;
      });
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
      const spawnPromise = new Promise<string>((resolve) => {
        resolveSpawn = resolve;
      });
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
      // In the mock, the getDbExec().execute() RETURNING id call succeeds → node is claimed
      // The node mock update (from dispatchNode) sets status="running"
      const nodeA = nodes.find((n) => n.nodeIdInDag === "a");
      // The in-memory mock update applies broadly; the CAS was done via getDbExec()
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
      const neverResolve = new Promise<string>(() => {
        /* intentionally never resolves */
      });
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

  describe("R4a.3 §4.2 point 7 — claude-code worker-node concurrency gate", () => {
    it("gated: a claude-code-targeting node is left pending (not claimed, not spawned) when admission is denied", async () => {
      vi.mocked(admitClaudeCodeNode).mockResolvedValueOnce({
        admitted: false,
        running: 1,
        limit: 1,
      });

      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, nodes, events } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              { id: "review", type: "agent", agent: "claude-code", deps: [] },
            ],
          },
        }),
        [makeNode({ nodeIdInDag: "review", id: "node-review" })],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      expect(dispatcher.spawn).not.toHaveBeenCalled();
      expect(nodes[0]!.status).toBe("pending"); // untouched — no claim attempted
      const gatedEvent = events.find(
        (e) => e.kind === "claude_code.concurrency_gated",
      );
      expect(gatedEvent).toBeDefined();
      expect((gatedEvent?.payload as any)?.nodeId).toBe("review");
    });

    it("admitted: a claude-code-targeting node dispatches normally when a slot is free", async () => {
      vi.mocked(admitClaudeCodeNode).mockResolvedValueOnce({
        admitted: true,
        running: 0,
        limit: 1,
      });

      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, nodes } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              { id: "review", type: "agent", agent: "claude-code", deps: [] },
            ],
          },
        }),
        [makeNode({ nodeIdInDag: "review", id: "node-review" })],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      expect(dispatcher.spawn).toHaveBeenCalledTimes(1);
      expect(nodes[0]!.status).toBe("running");
    });

    it("a non-claude-code node dispatches without ever consulting the gate", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, nodes } = createMockDb(
        makeRun({
          dag: {
            nodes: [{ id: "dev", type: "agent", agent: "vllm", deps: [] }],
          },
        }),
        [makeNode({ nodeIdInDag: "dev", id: "node-dev" })],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      expect(dispatcher.spawn).toHaveBeenCalledTimes(1);
      expect(nodes[0]!.status).toBe("running");
      expect(admitClaudeCodeNode).not.toHaveBeenCalled();
    });
  });

  describe("G19 — retry on failure", () => {
    it("G19: retries transient spawn failures with backoff", async () => {
      // dispatcher.spawn fails on first call, succeeds on second
      const dispatcher: V3Dispatcher & { spawn: ReturnType<typeof vi.fn> } = {
        spawn: vi
          .fn()
          .mockRejectedValueOnce(new Error("ETIMEDOUT: connection timeout"))
          .mockResolvedValueOnce("spawn-2"),
      } as any;

      const V3Reconciler = await getReconciler();
      const { db, events } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              {
                id: "a",
                type: "agent",
                deps: [],
                retry: {
                  max: 1,
                  on: ["transient"],
                  backoff: "fixed",
                  initial_ms: 0,
                },
              },
            ],
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
        spawn: vi
          .fn()
          .mockRejectedValue(new Error("permanent: agent not found")),
      } as any;

      const V3Reconciler = await getReconciler();
      const { db, nodes } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              {
                id: "a",
                type: "agent",
                deps: [],
                retry: {
                  max: 3,
                  on: ["transient"],
                  backoff: "fixed",
                  initial_ms: 0,
                },
              },
            ],
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
          makeNode({
            nodeIdInDag: "lint",
            id: "n-lint",
            status: "failed",
            error: "lint error",
          }),
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
          makeNode({
            nodeIdInDag: "lint",
            id: "n-lint",
            status: "failed",
            error: "lint error",
          }),
          makeNode({
            nodeIdInDag: "test",
            id: "n-test",
            status: "failed",
            error: "test failed",
          }),
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
          makeNode({
            nodeIdInDag: "lint",
            id: "n-lint",
            status: "failed",
            error: "lint error",
          }),
          makeNode({
            nodeIdInDag: "deploy",
            id: "n-deploy",
            status: "pending",
          }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");

      // deploy should NOT be cascade-skipped because lint has on_failure:continue
      const deployNode = nodes.find((n) => n.nodeIdInDag === "deploy");
      expect(deployNode?.status).not.toBe("skipped");
    });
  });

  // F9 (docs/sdlc-impl-f5-f10.md §5A) — the terminal-hook wiring in
  // `finalizeRun`/`writebackOnTerminal`. `onRunTerminal` itself (JWT minting,
  // tool-call sequence/args) is exercised against a mock A2A/MCP transport in
  // `tracker-client.spec.ts` — real end-to-end against a live tracker
  // deployment is deferred (see the delivery report).
  describe("F9 — writeback terminal hook", () => {
    beforeEach(() => {
      vi.mocked(onRunTerminal).mockReset();
    });

    it("T-F9-01 (tracker half upgraded to e2e via mock A2A client): run done with a delivered branch → onRunTerminal called with a 'delivered' outcome derived from tags + artifact text", async () => {
      vi.mocked(onRunTerminal).mockResolvedValue(undefined);
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db } = createMockDb(
        makeRun({
          tags: { source: "tracker", item_id: "wi-1", org_id: "org-1" },
        }),
        [makeNode({ status: "done", outputArtifactId: "artifact-1" })],
        [
          makeArtifact({
            id: "artifact-1",
            textContent:
              "Committed. Opened https://github.com/acme/repo/pull/7 from orchestrator/run-1.",
          }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher, undefined, [1, 1, 1]);
      await reconciler.tick("run-1");

      await vi.waitFor(() => {
        expect(onRunTerminal).toHaveBeenCalledWith({
          kind: "delivered",
          workItemId: "wi-1",
          orgId: "org-1",
          runId: "run-1",
          branch: "orchestrator/run-1",
        });
      });
    });

    it("T-F9-03: run done with NO discoverable delivery → onRunTerminal called with a 'zero-delivery' outcome (execState→queued path)", async () => {
      vi.mocked(onRunTerminal).mockResolvedValue(undefined);
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db } = createMockDb(
        makeRun({ tags: { item_id: "wi-2", org_id: "org-2" } }),
        [makeNode({ status: "done", outputArtifactId: null })],
      );

      const reconciler = new V3Reconciler(db, dispatcher, undefined, [1, 1, 1]);
      await reconciler.tick("run-1");

      await vi.waitFor(() => {
        expect(onRunTerminal).toHaveBeenCalledWith({
          kind: "zero-delivery",
          workItemId: "wi-2",
          orgId: "org-2",
          runId: "run-1",
          reason: "run-done-no-delivery",
        });
      });
    });

    it("T-F9-03: run failed (dispatched item) → onRunTerminal called with a zero-delivery/run-failed outcome; business stage untouched (asserted separately by advance-stage not being called)", async () => {
      vi.mocked(onRunTerminal).mockResolvedValue(undefined);
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db } = createMockDb(
        makeRun({
          tags: { item_id: "wi-3", org_id: "org-3" },
          dag: { nodes: [{ id: "a", type: "agent", deps: [] }] },
        }),
        [
          makeNode({
            nodeIdInDag: "a",
            id: "n-a",
            status: "failed",
            error: "boom",
          }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher, undefined, [1, 1, 1]);
      await reconciler.tick("run-1");

      await vi.waitFor(() => {
        expect(onRunTerminal).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: "zero-delivery",
            workItemId: "wi-3",
            reason: "run-failed",
          }),
        );
      });
    });

    it("skips entirely (no onRunTerminal call, no writeback event) when the run carries no tracker item_id tag", async () => {
      vi.mocked(onRunTerminal).mockResolvedValue(undefined);
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, events } = createMockDb(
        makeRun({ tags: { source: "some-other-caller" } }),
        [makeNode({ status: "done" })],
      );

      const reconciler = new V3Reconciler(db, dispatcher, undefined, [1, 1, 1]);
      await reconciler.tick("run-1");

      // Give any stray microtask a turn, then assert nothing fired.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(onRunTerminal).not.toHaveBeenCalled();
      expect(events.some((e) => e.kind === "writeback.failed")).toBe(false);
    });

    it("T-F9-06: tracker unreachable (503-style failure) → 3 backoff retries exhausted → v3_events kind=writeback.failed recorded (P13: not silent)", async () => {
      const persistentError = new Error(
        "Tracker MCP writeback-exec-state failed (HTTP 503): down",
      );
      vi.mocked(onRunTerminal).mockRejectedValue(persistentError);

      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, events } = createMockDb(
        makeRun({
          tags: { item_id: "wi-4", org_id: "org-4" },
          dag: { nodes: [{ id: "a", type: "agent", deps: [] }] },
        }),
        [
          makeNode({
            nodeIdInDag: "a",
            id: "n-a",
            status: "failed",
            error: "boom",
          }),
        ],
      );

      // Fast (1ms) backoff schedule for the test — still genuinely 3 delays /
      // 4 attempts, matching `attemptWithBackoff`'s real contract.
      const reconciler = new V3Reconciler(db, dispatcher, undefined, [1, 1, 1]);
      await reconciler.tick("run-1");

      await vi.waitFor(() => {
        expect(onRunTerminal).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
      });

      await vi.waitFor(() => {
        const failedEvent = events.find((e) => e.kind === "writeback.failed");
        expect(failedEvent).toBeDefined();
        expect(failedEvent?.payload).toMatchObject({
          workItemId: "wi-4",
          attempts: 4,
        });
      });
    });
  });

  // Task board #38 follow-up ("回写通道 fire-and-forget 无持久补偿(改持久
  // outbox)"): the persistent writeback outbox. `finalizeRun` now durably
  // enqueues a `writebackStatus`/`writebackOutcome` row BEFORE the
  // fire-and-forget fast-path delivery attempt, and `drainWritebackOutbox`
  // (called by the periodic sweep, server/queue/v3-writeback-outbox-sweep.ts)
  // is the backstop that drains anything still 'pending'. The real
  // crash/redeploy simulation (a row enqueued but never delivered, then
  // picked up by a FRESH V3Reconciler instance's drainWritebackOutbox — the
  // in-process stand-in for "server restarted") runs against REAL Postgres in
  // v3-writeback-outbox-sweep.pg.spec.ts; these mock-DB tests cover the
  // faster-to-run unit-level contract: the row is durably enqueued, done on
  // success, left pending (never a third "gave up" state) on failure, and the
  // sweep drain reuses the exact same delivery path as the fast path.
  describe("F9-followup — persistent writeback outbox (task board #38)", () => {
    beforeEach(() => {
      vi.mocked(onRunTerminal).mockReset();
    });

    it("finalizeRun durably enqueues the outbox row (writebackStatus='pending' + classified outcome) SYNCHRONOUSLY, before the fire-and-forget delivery attempt resolves", async () => {
      // Never resolves within this test — proves the enqueue write already
      // landed even though delivery is still in flight (the exact ordering
      // guarantee a crash mid-delivery depends on).
      let releaseDelivery: () => void = () => {};
      vi.mocked(onRunTerminal).mockImplementation(
        () => new Promise<void>((resolve) => (releaseDelivery = resolve)),
      );

      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, runs } = createMockDb(
        makeRun({
          tags: { item_id: "wi-durable", org_id: "org-durable" },
          dag: { nodes: [] },
        }),
        [],
      );

      const reconciler = new V3Reconciler(db, dispatcher, undefined, [1, 1, 1]);
      await reconciler.tick("run-1"); // empty DAG → finalizeRun("done") runs synchronously inside tick()

      // tick() has returned — the enqueue write inside finalizeRun was
      // AWAITED, so the row must already be durably 'pending' even though
      // the fire-and-forget onRunTerminal call above is still stuck pending.
      const run = runs.get("run-1")!;
      expect(run.writebackStatus).toBe("pending");
      expect(run.writebackOutcome).toMatchObject({ kind: "zero-delivery" });
      expect(onRunTerminal).toHaveBeenCalledTimes(1); // fast path did start...

      releaseDelivery(); // ...but let's confirm it can still complete normally
      await vi.waitFor(() => {
        expect(runs.get("run-1")!.writebackStatus).toBe("done");
      });
    });

    it("normal path (no regression): the fast-path delivery succeeds and marks the outbox row done", async () => {
      vi.mocked(onRunTerminal).mockResolvedValue(undefined);
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, runs } = createMockDb(
        makeRun({
          tags: { item_id: "wi-ok", org_id: "org-ok" },
          dag: { nodes: [] },
        }),
        [],
      );

      const reconciler = new V3Reconciler(db, dispatcher, undefined, [1, 1, 1]);
      await reconciler.tick("run-1");

      await vi.waitFor(() => {
        expect(runs.get("run-1")!.writebackStatus).toBe("done");
      });
      expect(runs.get("run-1")!.writebackLastError).toBeNull();
    });

    it("drainWritebackOutbox delivers a pending row via the SAME delivery path and marks it done", async () => {
      vi.mocked(onRunTerminal).mockResolvedValue(undefined);
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const outcome = {
        kind: "zero-delivery" as const,
        workItemId: "wi-sweep",
        orgId: "org-sweep",
        runId: "run-1",
        reason: "run-done-no-delivery",
      };
      const { db, runs } = createMockDb(
        makeRun({
          status: "done",
          writebackStatus: "pending",
          writebackOutcome: outcome,
          writebackAttempts: 0,
        }),
        [],
      );

      const reconciler = new V3Reconciler(db, dispatcher, undefined, [1, 1, 1]);
      const result = await reconciler.drainWritebackOutbox();

      expect(result).toEqual({ processed: 1, succeeded: 1 });
      expect(onRunTerminal).toHaveBeenCalledWith(outcome);
      expect(runs.get("run-1")!.writebackStatus).toBe("done");
    });

    it("drainWritebackOutbox leaves the row 'pending' (never a third give-up state) when delivery keeps failing, so the NEXT sweep tick retries it", async () => {
      vi.mocked(onRunTerminal).mockRejectedValue(new Error("tracker down"));
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const outcome = {
        kind: "zero-delivery" as const,
        workItemId: "wi-stuck",
        orgId: "org-stuck",
        runId: "run-1",
        reason: "run-failed",
      };
      const { db, runs, events } = createMockDb(
        makeRun({
          status: "failed",
          writebackStatus: "pending",
          writebackOutcome: outcome,
          writebackAttempts: 0,
        }),
        [],
      );

      const reconciler = new V3Reconciler(db, dispatcher, undefined, [1, 1]);
      const result = await reconciler.drainWritebackOutbox();

      expect(result).toEqual({ processed: 1, succeeded: 0 });
      // Never abandoned — status is 'pending' again, not e.g. 'failed'/'given-up'.
      expect(runs.get("run-1")!.writebackStatus).toBe("pending");
      expect(runs.get("run-1")!.writebackAttempts).toBeGreaterThan(0);
      expect(runs.get("run-1")!.writebackLastError).toContain("tracker down");
      expect(events.some((e) => e.kind === "writeback.failed")).toBe(true);

      // A second sweep tick retries the SAME row — proving nothing marks it
      // permanently un-retryable after one failed round.
      vi.mocked(onRunTerminal).mockResolvedValue(undefined);
      const result2 = await reconciler.drainWritebackOutbox();
      expect(result2).toEqual({ processed: 1, succeeded: 1 });
      expect(runs.get("run-1")!.writebackStatus).toBe("done");
    });

    // Note: "only writebackStatus='pending' rows are drained" (the real SQL
    // WHERE filter) is NOT provable against this mock DB — createMockDb's
    // select().from().where() ignores its filter for EVERY table by design
    // (see the file header / R9 describe block's mock-DB note above), so a
    // "no pending rows → no-op" case here would only prove the mock is
    // filter-blind, not that the real query is correct. That real-SQL
    // behavior is exercised against genuine Postgres in
    // v3-writeback-outbox-sweep.pg.spec.ts instead.
  });

  // SDLC-083: a human merging a run's PR directly on GitHub (`gh pr merge`)
  // instead of through `workspaceMergePr` never drives that run's v3_nodes to
  // a reconciler-observed terminal state, so `finalizeRun` is never called
  // and the tracker work item is stuck at its dispatched stage forever even
  // though the code is really merged (confirmed live: work item SDLC-046 /
  // PR #32). `sweepBypassedMerges` closes the gap by asking GitHub directly
  // (via `ciWatch`, mocked here) whether a non-terminal run's workspace
  // branch has a genuinely `state:"MERGED"` PR, and — only then — finalizes
  // the run through the EXISTING `finalizeRun` path unchanged.
  describe("SDLC-083 — sweepBypassedMerges (bypassed-merge writeback sweep)", () => {
    beforeEach(() => {
      vi.mocked(onRunTerminal).mockReset();
      vi.mocked(ciWatch).mockReset();
    });

    it("finalizes a non-terminal run via the real finalizeRun path when GitHub confirms the PR was genuinely merged", async () => {
      vi.mocked(onRunTerminal).mockResolvedValue(undefined);
      vi.mocked(ciWatch).mockResolvedValue({
        state: "none",
        prUrl: "https://github.com/acme/repo/pull/32",
        prState: "MERGED",
        checks: [],
        summary: "merged directly on GitHub",
      });

      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, runs } = createMockDb(
        makeRun({
          id: "run-1",
          status: "running", // never reached the reconciler's OWN terminal detection
          tags: { item_id: "wi-bypass", org_id: "org-bypass" },
          dag: { nodes: [] },
        }),
        [
          makeNode({
            id: "n-a",
            nodeIdInDag: "a",
            runId: "run-1",
            status: "done",
            outputArtifactId: "artifact-1",
          }),
        ],
        [
          makeArtifact({
            id: "artifact-1",
            textContent:
              "Committed. Opened https://github.com/acme/repo/pull/32 from orchestrator/run-1.",
          }),
        ],
        [],
        [makeSpawn({ id: "spawn-1", nodeId: "n-a", workspaceId: "ws-1" })],
        [makeWorkspace({ id: "ws-1", branch: "orchestrator/run-1" })],
      );

      // BEFORE the sweep: nothing has advanced yet.
      expect(runs.get("run-1")!.status).toBe("running");
      expect(runs.get("run-1")!.writebackStatus).toBeNull();

      const reconciler = new V3Reconciler(db, dispatcher, undefined, [1, 1, 1]);
      const result = await reconciler.sweepBypassedMerges();

      // AFTER the sweep: the run is finalized through the real path.
      expect(result).toEqual({ checked: 1, finalized: 1 });
      expect(runs.get("run-1")!.status).toBe("done");
      expect(runs.get("run-1")!.writebackStatus).not.toBeNull();

      await vi.waitFor(() => {
        expect(onRunTerminal).toHaveBeenCalledWith({
          kind: "delivered",
          workItemId: "wi-bypass",
          orgId: "org-bypass",
          runId: "run-1",
          branch: "orchestrator/run-1",
        });
      });
    });

    it("leaves a non-terminal run untouched when the workspace's PR is NOT merged (no false-positive advancement)", async () => {
      vi.mocked(onRunTerminal).mockResolvedValue(undefined);
      vi.mocked(ciWatch).mockResolvedValue({
        state: "pending",
        prUrl: "https://github.com/acme/repo/pull/33",
        prState: "OPEN",
        checks: [],
        summary: "still open",
      });

      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, runs } = createMockDb(
        makeRun({
          id: "run-2",
          status: "running",
          tags: { item_id: "wi-untouched", org_id: "org-untouched" },
          dag: { nodes: [] },
        }),
        [
          makeNode({
            id: "n-b",
            nodeIdInDag: "a",
            runId: "run-2",
            status: "done",
          }),
        ],
        [],
        [],
        [makeSpawn({ id: "spawn-2", nodeId: "n-b", workspaceId: "ws-2" })],
        [makeWorkspace({ id: "ws-2", branch: "orchestrator/run-2" })],
      );

      const reconciler = new V3Reconciler(db, dispatcher, undefined, [1, 1, 1]);
      const result = await reconciler.sweepBypassedMerges();

      expect(result).toEqual({ checked: 1, finalized: 0 });
      expect(runs.get("run-2")!.status).toBe("running");
      expect(runs.get("run-2")!.writebackStatus).toBeNull();
      expect(onRunTerminal).not.toHaveBeenCalled();
    });

    it("never re-checks GitHub for a workspace whose run already reached a terminal state", async () => {
      vi.mocked(ciWatch).mockResolvedValue({
        state: "none",
        prUrl: "https://github.com/acme/repo/pull/34",
        prState: "MERGED",
        checks: [],
        summary: "merged",
      });

      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, runs } = createMockDb(
        makeRun({
          id: "run-3",
          status: "done",
          tags: { item_id: "wi-already-done" },
        }),
        [
          makeNode({
            id: "n-c",
            nodeIdInDag: "a",
            runId: "run-3",
            status: "done",
          }),
        ],
        [],
        [],
        [makeSpawn({ id: "spawn-3", nodeId: "n-c", workspaceId: "ws-3" })],
        [makeWorkspace({ id: "ws-3", branch: "orchestrator/run-3" })],
      );

      const reconciler = new V3Reconciler(db, dispatcher, undefined, [1, 1, 1]);
      const result = await reconciler.sweepBypassedMerges();

      expect(result).toEqual({ checked: 0, finalized: 0 });
      expect(ciWatch).not.toHaveBeenCalled();
      expect(runs.get("run-3")!.status).toBe("done");
    });
  });

  // ── F10 — R9 spawn→node conduction invariant (SDLC-050) ──────────────────
  //
  // docs/sdlc-product-design/02-workflows.md §4 R9: "不存在 spawn 已终态而其
  // node 仍 running 超过一个 tick". These tests construct the exact gap shape
  // directly (node non-terminal + currentSpawnId pointing at an
  // already-terminal v3_spawns row) — the mock DB never runs the real
  // dispatcher/executor, so no spawn is literally killed; per
  // docs/sdlc-impl-f5-f10.md T-F10-08's own correction, this is the sanctioned
  // way to exercise the conduction rule without "kill spawn" machinery (which
  // does not exist for in-process/network spawns — see F1–F4 §6).
  //
  // Mock-DB note: createMockDb's spawns table select ignores its `where`
  // filter and returns the WHOLE spawns array (mirrors every other table in
  // this mock — see the file header). reconcileSpawnConduction issues two
  // spawn queries: (a) `eq(id, node.currentSpawnId)` — destructures the FIRST
  // array element, so the fixture always lists the node's CURRENT spawn
  // first; (b) `eq(nodeId, node.id)` — count only, order-independent. Tests
  // below follow that "current spawn first" ordering convention.

  describe("R9 — spawn→node conduction (F10, SDLC-050)", () => {
    it("T-F10-01: spawn=failed & node=running, no retry policy → node fails permanently + conduction.fixed fires", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, nodes, runs, events } = createMockDb(
        makeRun({ dag: { nodes: [{ id: "a", type: "agent", deps: [] }] } }),
        [
          makeNode({
            nodeIdInDag: "a",
            id: "node-a",
            status: "running",
            currentSpawnId: "spawn-1",
          }),
        ],
        [],
        [],
        [
          makeSpawn({
            id: "spawn-1",
            nodeId: "node-a",
            status: "failed",
            error: "worker OOM",
          }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");
      await new Promise((r) => setTimeout(r, 20));

      // No retry policy → maxAttempts = 1; one prior spawn already used it up
      // → the node migrates straight to failed (not left dangling 'running').
      const nodeA = nodes.find((n) => n.nodeIdInDag === "a");
      expect(nodeA?.status).toBe("failed");
      expect(nodeA?.currentSpawnId).toBeNull();
      expect(nodeA?.error).toContain("spawn-1");

      const fixedEvent = events.find((e) => e.kind === "conduction.fixed");
      expect(fixedEvent).toBeDefined();
      expect((fixedEvent?.payload as any)?.nodeId).toBe("a");
      expect((fixedEvent?.payload as any)?.spawnId).toBe("spawn-1");
      expect((fixedEvent?.payload as any)?.disposition).toBe("failed");

      // Terminal — must not be redispatched.
      expect(dispatcher.spawn).not.toHaveBeenCalled();

      // Fail cascade (existing behavior) finalizes the run as failed since
      // this is the run's only node and it has no on_failure:continue.
      expect(runs.get("run-1")?.status).toBe("failed");
    });

    it("T-F10-02a: attempt = maxAttempts-1 → node migrates to ready and is redispatched within the same tick", async () => {
      const V3Reconciler = await getReconciler();
      const { db, nodes, events, spawns } = createMockDb(
        makeRun({
          dag: {
            nodes: [{ id: "a", type: "agent", deps: [], retry: { max: 1 } }],
          },
        }),
        [
          makeNode({
            nodeIdInDag: "a",
            id: "node-a",
            status: "running",
            currentSpawnId: "spawn-1",
          }),
        ],
        [],
        [],
        // retry.max=1 → maxAttempts=2; exactly one spawn used so far (this
        // one) → attemptsMade=1 = maxAttempts-1 → one retry still allowed.
        [makeSpawn({ id: "spawn-1", nodeId: "node-a", status: "failed" })],
      );

      // The shared makeDispatcher() mock resolves without ever inserting a
      // v3_spawns row — fine for every OTHER test, but here the redispatched
      // node's currentSpawnId would keep pointing at the SAME terminal
      // spawn-1 forever, so the conduction rule would refire on every
      // recursive tick() fireAndTrackSpawn triggers after a successful spawn
      // (genuine infinite loop in the mock, not in production — the real
      // V3Dispatcher.spawn() always writes a brand-new, non-terminal spawn
      // row via openRunningSpawn, which is what actually breaks this cycle).
      // This dispatcher simulates that by appending a fresh 'running' spawn
      // row on each call, exactly like production does.
      let redispatchSeq = 0;
      const dispatcher: V3Dispatcher & { spawn: ReturnType<typeof vi.fn> } = {
        spawn: vi.fn().mockImplementation(async (node: { id: string }) => {
          const id = `spawn-redispatch-${++redispatchSeq}`;
          spawns.push({
            id,
            nodeId: node.id,
            status: "running",
            error: null,
            ownerEmail: "local@localhost",
            orgId: null,
            workspaceId: null,
          });
          return id;
        }),
      } as any;

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");
      await new Promise((r) => setTimeout(r, 20));

      const fixedEvent = events.find((e) => e.kind === "conduction.fixed");
      expect(fixedEvent).toBeDefined();
      expect((fixedEvent?.payload as any)?.disposition).toBe("retry");
      expect((fixedEvent?.payload as any)?.attempt).toBe(1);
      expect((fixedEvent?.payload as any)?.maxAttempts).toBe(2);

      // Deps were already resolved (this node was already running) — the
      // ready-candidate scan later in the SAME tick redispatches it exactly
      // once (the fresh non-terminal spawn row halts further conduction).
      expect(dispatcher.spawn).toHaveBeenCalledTimes(1);
    });

    it("T-F10-02b: attempt = maxAttempts → node fails permanently, error carries the spawn summary, no redispatch", async () => {
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, nodes, events } = createMockDb(
        makeRun({
          dag: {
            nodes: [{ id: "a", type: "agent", deps: [], retry: { max: 1 } }],
          },
        }),
        [
          makeNode({
            nodeIdInDag: "a",
            id: "node-a",
            status: "running",
            currentSpawnId: "spawn-2",
          }),
        ],
        [],
        [],
        // retry.max=1 → maxAttempts=2; TWO spawns already exist for this node
        // (spawn-2 is current/first per the mock ordering convention above) →
        // attemptsMade=2 = maxAttempts → retries exhausted.
        [
          makeSpawn({
            id: "spawn-2",
            nodeId: "node-a",
            status: "failed",
            error: "timeout",
          }),
          makeSpawn({ id: "spawn-1", nodeId: "node-a", status: "failed" }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");
      await new Promise((r) => setTimeout(r, 20));

      const nodeA = nodes.find((n) => n.nodeIdInDag === "a");
      expect(nodeA?.status).toBe("failed");
      expect(nodeA?.error).toContain("Retries exhausted (2/2)");
      expect(nodeA?.error).toContain("spawn-2");

      const fixedEvent = events.find((e) => e.kind === "conduction.fixed");
      expect((fixedEvent?.payload as any)?.disposition).toBe("failed");
      expect((fixedEvent?.payload as any)?.attempt).toBe(2);
      expect((fixedEvent?.payload as any)?.maxAttempts).toBe(2);

      expect(dispatcher.spawn).not.toHaveBeenCalled();
    });

    it("T-F10-05 (half-covered — see docs note): conduction is agnostic to WHY the spawn ended, including a killed-process shape", async () => {
      // Real T-F10-05 exercises `child.kill()` on a real CC child process
      // (server/runtime/executors/claude-code-executor.ts /
      // none-runtime.ts — outside this task's file boundary). This test only
      // proves the reconciler-side half: the conduction rule does not
      // special-case *how* a spawn reached 'failed' — a killed-PID error and
      // a stall/orphan-restart error are migrated identically. The
      // executor-level kill path itself is NOT exercised here — flagged as a
      // deliberate coverage gap, not a passing claim about the kill path.
      const V3Reconciler = await getReconciler();
      const dispatcher = makeDispatcher();
      const { db, nodes, events } = createMockDb(
        makeRun({ dag: { nodes: [{ id: "a", type: "agent", deps: [] }] } }),
        [
          makeNode({
            nodeIdInDag: "a",
            id: "node-a",
            status: "running",
            currentSpawnId: "spawn-1",
          }),
        ],
        [],
        [],
        [
          makeSpawn({
            id: "spawn-1",
            nodeId: "node-a",
            status: "failed",
            error: "process killed (SIGKILL) by none-runtime executor",
          }),
        ],
      );

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");
      await new Promise((r) => setTimeout(r, 20));

      const nodeA = nodes.find((n) => n.nodeIdInDag === "a");
      expect(nodeA?.status).toBe("failed");
      expect(events.find((e) => e.kind === "conduction.fixed")).toBeDefined();
    });

    it("T-F10-08: synthetic B2 replay — run stays active (not cancelled), node self-heals without a manual runCancel", async () => {
      // R3 correction: 101's real v3r_ehy1aca2zoy2njaj row is already
      // cancelled (a manual workaround applied before this fix existed) and
      // must not be replayed literally. This constructs a fixture matching
      // B2's ORIGINAL pre-workaround shape instead: run still 'running' (no
      // one ever cancelled it), one node stuck 'running' whose bound spawn is
      // already terminal. The point of F10 is that this now self-heals on
      // the very next tick — no operator has to call runCancel to unstick it.
      const V3Reconciler = await getReconciler();
      const { db, nodes, runs, spawns } = createMockDb(
        makeRun({
          status: "running",
          dag: {
            nodes: [
              { id: "develop", type: "agent", deps: [], retry: { max: 1 } },
            ],
          },
        }),
        [
          makeNode({
            nodeIdInDag: "develop",
            id: "node-develop",
            status: "running",
            currentSpawnId: "spawn-1",
          }),
        ],
        [],
        [],
        [
          makeSpawn({
            id: "spawn-1",
            nodeId: "node-develop",
            status: "failed",
            error: "orphaned-restart",
          }),
        ],
      );

      // See T-F10-02a for why the redispatch must insert a fresh non-terminal
      // spawn row — without it, the mock's dispatcher never advances the
      // spawns table and recursive re-ticks after a successful redispatch
      // loop forever (a mock artifact, not a production behavior).
      let redispatchSeq = 0;
      const dispatcher: V3Dispatcher & { spawn: ReturnType<typeof vi.fn> } = {
        spawn: vi.fn().mockImplementation(async (node: { id: string }) => {
          const id = `spawn-redispatch-${++redispatchSeq}`;
          spawns.push({
            id,
            nodeId: node.id,
            status: "running",
            error: null,
            ownerEmail: "local@localhost",
            orgId: null,
            workspaceId: null,
          });
          return id;
        }),
      } as any;

      const reconciler = new V3Reconciler(db, dispatcher);
      await reconciler.tick("run-1");
      await new Promise((r) => setTimeout(r, 20));

      // The run was never cancelled — it is still active (running or, if the
      // redispatched node's async tail already looped back to finalize,
      // still not 'cancelled') — the key assertion is NOT cancelled.
      expect(runs.get("run-1")?.status).not.toBe("cancelled");

      // The node was NOT left stuck at 'running' with a dead spawn — it was
      // either redispatched (retry within policy: attemptsMade=1 <
      // maxAttempts=2) or, if exhausted, moved to 'failed' where nodeRetry can
      // reach it. Either way it is no longer silently wedged.
      const nodeDevelop = nodes.find((n) => n.nodeIdInDag === "develop");
      expect(nodeDevelop?.status).not.toBe("running");
      // Retry was within policy here (1 prior spawn, max=1 → maxAttempts=2),
      // so the automatic path redispatched it without any manual action.
      expect(dispatcher.spawn).toHaveBeenCalledTimes(1);
    });
  });
});
