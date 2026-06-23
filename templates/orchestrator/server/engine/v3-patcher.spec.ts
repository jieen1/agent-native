// V3 Patcher Unit Tests
//
// Tests CAS, 5 mutation types, cycle detection, and conflict handling.
// All DB queries and dag-validator are mocked.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

// ── Mock dependencies ───────────────────────────────────────────────────────

const hoisted = vi.hoisted(() => ({
  validateDagResult: { ok: true, errors: [] } as { ok: boolean; errors: string[] },
  detectCycleResult: null as string | null,
  insertedPatches: [] as Array<Record<string, unknown>>,
  updatedRuns: [] as Array<Record<string, unknown>>,
}));

vi.mock("./dag-validator.js", () => ({
  validateDag: vi.fn(() => hoisted.validateDagResult),
  detectCycle: vi.fn(() => hoisted.detectCycleResult),
}));

vi.mock("nanoid", () => ({
  customAlphabet: vi.fn(() => vi.fn(() => "abc123def456")),
}));

// ── Mock DB Builder ──────────────────────────────────────────────────────────

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

function createMockDb(
  initialRun: MockRunRow,
  initialNodes: MockNodeRow[],
  opts: { notFoundForRunId?: string } = {},
) {
  const runs: Map<string, MockRunRow> = new Map();
  runs.set(initialRun.id, { ...initialRun });
  const nodes: MockNodeRow[] = initialNodes.map((n) => ({ ...n }));

  // Simulate eq filter: if the test wants "not found" for a specific runId
  let notFoundRunId: string | null = opts.notFoundForRunId ?? null;

  // Use selectSeq to distinguish first select (run) from second (nodes)
  let selectSeq = 0;

  const db = {
    select: () => ({
      from: (_table: unknown) => ({
        where: async (_filter: unknown) => {
          selectSeq++;
          // We disambiguate by checking the v3Nodes table has nodeIdInDag
          const isNodesTable = (arg: any) => arg?.nodeIdInDag !== undefined;
          if (isNodesTable(_table)) {
            return nodes;
          }
          // First select is for the run — check if we should simulate not-found
          if (notFoundRunId) return [];
          return Array.from(runs.values());
        },
      }),
    }),
    transaction: async (fn: (tx: any) => Promise<void>) => {
      const tx = {
        insert: (_table: unknown) => ({
          values: async (row: Record<string, unknown>) => {
            hoisted.insertedPatches.push(row);
            return {};
          },
        }),
        update: (_table: unknown) => ({
          set: (data: Record<string, unknown>) => ({
            where: async (_filter: unknown) => {
              hoisted.updatedRuns.push(data);
              // Apply the update to the in-memory run
              for (const [, run] of runs) {
                if (data.dag) run.dag = data.dag;
                if (data.dagVersion) run.dagVersion = data.dagVersion as number;
              }
              return {};
            },
          }),
        }),
      };
      await fn(tx);
    },
  } as unknown as PostgresJsDatabase;

  return { db, runs, nodes, reset: () => {
    hoisted.insertedPatches.length = 0;
    hoisted.updatedRuns.length = 0;
  }};
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRun(overrides: Partial<MockRunRow> = {}): MockRunRow {
  return {
    id: "run-1",
    templateId: null,
    templateVersion: null,
    inputs: {},
    dag: {
      nodes: [
        { id: "a", type: "agent", agent: "impl", prompt: "Do it", deps: [] },
        { id: "b", type: "agent", agent: "review", prompt: "Review it", deps: ["a"] },
      ],
    },
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
    id: "node-a",
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

describe("V3Patcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.validateDagResult = { ok: true, errors: [] };
    hoisted.detectCycleResult = null;
    hoisted.insertedPatches.length = 0;
    hoisted.updatedRuns.length = 0;
  });

  async function getPatcher() {
    const mod = await import("./v3-patcher.js");
    return mod.V3Patcher;
  }

  describe("CAS — version check", () => {
    it("CAS success: matching dag_version applies patch", async () => {
      const V3Patcher = await getPatcher();
      const { db } = createMockDb(makeRun({ dagVersion: 1 }), [
        makeNode(),
        makeNode({ id: "node-b", nodeIdInDag: "b" }),
      ]);

      const patcher = new V3Patcher(db);
      const result = await patcher.applyPatch({
        runId: "run-1",
        dagVersion: 1,
        mutations: [
          {
            kind: "modify_node",
            nodeIdInDag: "a",
            prompt: "Updated prompt",
          },
        ],
        appliedBy: "agent",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.newDagVersion).toBe(2);
      }
    });

    it("CAS conflict: mismatched dag_version rejected", async () => {
      const V3Patcher = await getPatcher();
      const { db } = createMockDb(makeRun({ dagVersion: 3 }), [
        makeNode(),
      ]);

      const patcher = new V3Patcher(db);
      const result = await patcher.applyPatch({
        runId: "run-1",
        dagVersion: 1, // stale version
        mutations: [],
        appliedBy: "agent",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("version_conflict");
        expect(result.currentDagVersion).toBe(3);
      }
    });

    it("run not found returns error", async () => {
      const V3Patcher = await getPatcher();
      const { db } = createMockDb(makeRun(), [], { notFoundForRunId: "nonexistent" });

      const patcher = new V3Patcher(db);
      const result = await patcher.applyPatch({
        runId: "nonexistent",
        dagVersion: 1,
        mutations: [],
        appliedBy: "agent",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("not found");
      }
    });
  });

  describe("modify_node mutation", () => {
    it("modify_node updates prompt and model_override", async () => {
      const V3Patcher = await getPatcher();
      const { db } = createMockDb(makeRun({ dagVersion: 1 }), [
        makeNode(),
      ]);

      const patcher = new V3Patcher(db);
      const result = await patcher.applyPatch({
        runId: "run-1",
        dagVersion: 1,
        mutations: [
          {
            kind: "modify_node",
            nodeIdInDag: "a",
            prompt: "New prompt",
            model_override: "claude-opus-4-5",
          },
        ],
        appliedBy: "agent",
      });

      expect(result.success).toBe(true);
    });

    it("modify_node rejects non-agent node", async () => {
      const V3Patcher = await getPatcher();
      const { db } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              { id: "loop1", type: "loop", body: "b", deps: [] },
            ],
          },
        }),
        [makeNode({ nodeIdInDag: "loop1", type: "loop" })],
      );

      const patcher = new V3Patcher(db);
      const result = await patcher.applyPatch({
        runId: "run-1",
        dagVersion: 1,
        mutations: [
          {
            kind: "modify_node",
            nodeIdInDag: "loop1",
            prompt: "Should fail",
          },
        ],
        appliedBy: "agent",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("not an agent node");
      }
    });

    it("modify_node rejects missing node", async () => {
      const V3Patcher = await getPatcher();
      const { db } = createMockDb(makeRun({ dagVersion: 1 }), [
        makeNode(),
      ]);

      const patcher = new V3Patcher(db);
      const result = await patcher.applyPatch({
        runId: "run-1",
        dagVersion: 1,
        mutations: [
          {
            kind: "modify_node",
            nodeIdInDag: "nonexistent",
            prompt: "nope",
          },
        ],
        appliedBy: "agent",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("not found");
      }
    });
  });

  describe("add_node mutation", () => {
    it("add_node pushes new node to DAG", async () => {
      const V3Patcher = await getPatcher();
      const { db } = createMockDb(makeRun({ dagVersion: 1 }), [
        makeNode(),
      ]);

      const patcher = new V3Patcher(db);
      const result = await patcher.applyPatch({
        runId: "run-1",
        dagVersion: 1,
        mutations: [
          {
            kind: "add_node",
            node: {
              id: "c",
              type: "agent",
              agent: "tester",
              prompt: "Test it",
              deps: ["b"],
            },
          },
        ],
        appliedBy: "agent",
      });

      expect(result.success).toBe(true);
    });

    it("add_node rejects duplicate id", async () => {
      const V3Patcher = await getPatcher();
      const { db } = createMockDb(makeRun({ dagVersion: 1 }), [
        makeNode(),
      ]);

      const patcher = new V3Patcher(db);
      const result = await patcher.applyPatch({
        runId: "run-1",
        dagVersion: 1,
        mutations: [
          {
            kind: "add_node",
            node: {
              id: "a", // already exists
              type: "agent",
              agent: "tester",
              prompt: "dup",
            },
          },
        ],
        appliedBy: "agent",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("already exists");
      }
    });
  });

  describe("remove_node mutation", () => {
    it("remove_node succeeds when node is pending", async () => {
      const V3Patcher = await getPatcher();
      const { db } = createMockDb(makeRun({ dagVersion: 1 }), [
        makeNode({ status: "pending" }),
      ]);

      const patcher = new V3Patcher(db);
      const result = await patcher.applyPatch({
        runId: "run-1",
        dagVersion: 1,
        mutations: [
          {
            kind: "remove_node",
            nodeIdInDag: "a",
          },
        ],
        appliedBy: "agent",
      });

      expect(result.success).toBe(true);
    });

    it("remove_node succeeds when node is skipped", async () => {
      const V3Patcher = await getPatcher();
      const { db } = createMockDb(makeRun({ dagVersion: 1 }), [
        makeNode({ status: "skipped" }),
      ]);

      const patcher = new V3Patcher(db);
      const result = await patcher.applyPatch({
        runId: "run-1",
        dagVersion: 1,
        mutations: [
          {
            kind: "remove_node",
            nodeIdInDag: "a",
          },
        ],
        appliedBy: "agent",
      });

      expect(result.success).toBe(true);
    });

    it("remove_node blocked when node is running", async () => {
      const V3Patcher = await getPatcher();
      const { db } = createMockDb(makeRun({ dagVersion: 1 }), [
        makeNode({ status: "running" }),
      ]);

      const patcher = new V3Patcher(db);
      const result = await patcher.applyPatch({
        runId: "run-1",
        dagVersion: 1,
        mutations: [
          {
            kind: "remove_node",
            nodeIdInDag: "a",
          },
        ],
        appliedBy: "agent",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("must be pending or skipped");
      }
    });

    it("remove_node blocked when node is done", async () => {
      const V3Patcher = await getPatcher();
      const { db } = createMockDb(makeRun({ dagVersion: 1 }), [
        makeNode({ status: "done" }),
      ]);

      const patcher = new V3Patcher(db);
      const result = await patcher.applyPatch({
        runId: "run-1",
        dagVersion: 1,
        mutations: [
          {
            kind: "remove_node",
            nodeIdInDag: "a",
          },
        ],
        appliedBy: "agent",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("must be pending or skipped");
      }
    });
  });

  describe("modify_loop mutation", () => {
    it("modify_loop updates maxIterations and until", async () => {
      const V3Patcher = await getPatcher();
      const { db } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              {
                id: "loop1",
                type: "loop",
                body: "b",
                deps: [],
                maxIterations: 5,
                until: "false",
              },
            ],
          },
        }),
        [
          makeNode({ nodeIdInDag: "loop1", type: "loop", id: "node-loop" }),
        ],
      );

      const patcher = new V3Patcher(db);
      const result = await patcher.applyPatch({
        runId: "run-1",
        dagVersion: 1,
        mutations: [
          {
            kind: "modify_loop",
            nodeIdInDag: "loop1",
            maxIterations: 10,
            until: "inputs.done",
          },
        ],
        appliedBy: "agent",
      });

      expect(result.success).toBe(true);
    });

    it("modify_loop rejects non-loop node", async () => {
      const V3Patcher = await getPatcher();
      const { db } = createMockDb(makeRun({ dagVersion: 1 }), [
        makeNode(),
      ]);

      const patcher = new V3Patcher(db);
      const result = await patcher.applyPatch({
        runId: "run-1",
        dagVersion: 1,
        mutations: [
          {
            kind: "modify_loop",
            nodeIdInDag: "a",
            maxIterations: 5,
          },
        ],
        appliedBy: "agent",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("not a loop node");
      }
    });
  });

  describe("replace_dag mutation", () => {
    it("replace_dag succeeds when active nodes preserved", async () => {
      const V3Patcher = await getPatcher();
      const { db } = createMockDb(makeRun({ dagVersion: 1 }), [
        makeNode({ nodeIdInDag: "a", type: "agent", status: "running" }),
      ]);

      const patcher = new V3Patcher(db);
      const result = await patcher.applyPatch({
        runId: "run-1",
        dagVersion: 1,
        mutations: [
          {
            kind: "replace_dag",
            nodes: [
              {
                id: "a",
                type: "agent",
                agent: "impl",
                prompt: "Updated",
                deps: [],
              },
              {
                id: "c",
                type: "agent",
                agent: "test",
                prompt: "Test",
                deps: ["a"],
              },
            ],
          },
        ],
        appliedBy: "agent",
      });

      expect(result.success).toBe(true);
    });

    it("replace_dag rejects when active node removed", async () => {
      const V3Patcher = await getPatcher();
      const { db } = createMockDb(makeRun({ dagVersion: 1 }), [
        makeNode({ nodeIdInDag: "a", type: "agent", status: "done" }),
      ]);

      const patcher = new V3Patcher(db);
      const result = await patcher.applyPatch({
        runId: "run-1",
        dagVersion: 1,
        mutations: [
          {
            kind: "replace_dag",
            nodes: [
              {
                id: "b",
                type: "agent",
                agent: "new",
                prompt: "New node",
              },
            ],
          },
        ],
        appliedBy: "agent",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("missing from new DAG");
      }
    });

    it("replace_dag rejects when active node type changes", async () => {
      const V3Patcher = await getPatcher();
      const { db } = createMockDb(makeRun({ dagVersion: 1 }), [
        makeNode({ nodeIdInDag: "a", type: "agent", status: "done" }),
      ]);

      const patcher = new V3Patcher(db);
      const result = await patcher.applyPatch({
        runId: "run-1",
        dagVersion: 1,
        mutations: [
          {
            kind: "replace_dag",
            nodes: [
              {
                id: "a",
                type: "loop",
                body: "b",
                deps: [],
              } as any,
            ],
          },
        ],
        appliedBy: "agent",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("type changed");
      }
    });
  });

  describe("Cycle detection via validateDag", () => {
    it("validateDag rejects cyclic DAG", async () => {
      const V3Patcher = await getPatcher();
      // Mock validateDag to return failure
      hoisted.validateDagResult = {
        ok: false,
        errors: ["Cycle detected involving 'a'"],
      };

      const { db } = createMockDb(makeRun({ dagVersion: 1 }), [
        makeNode(),
      ]);

      const patcher = new V3Patcher(db);
      const result = await patcher.applyPatch({
        runId: "run-1",
        dagVersion: 1,
        mutations: [
          {
            kind: "add_node",
            node: {
              id: "c",
              type: "agent",
              agent: "impl",
              prompt: "test",
              deps: ["a"],
            },
          },
        ],
        appliedBy: "agent",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("validation_failed");
        expect(result.errors).toContainEqual(
          expect.stringContaining("Cycle"),
        );
      }
    });
  });

  describe("buildAdjacency and hasCycle exports", () => {
    it("buildAdjacency produces adjacency map from nodes", async () => {
      const { buildAdjacency } = await import("./v3-patcher.js");

      const nodes = [
        { id: "a", type: "agent", agent: "x", prompt: "p", deps: [] },
        { id: "b", type: "agent", agent: "x", prompt: "p", deps: ["a"] },
      ] as any;

      const adj = buildAdjacency(nodes);
      expect(adj.get("a")).toEqual([]);
      expect(adj.get("b")).toEqual(["a"]);
    });

    it("hasCycle detects cycle via detectCycle", async () => {
      const { hasCycle } = await import("./v3-patcher.js");

      const nodes = [
        { id: "a", type: "agent", agent: "x", prompt: "p", deps: ["b"] },
        { id: "b", type: "agent", agent: "x", prompt: "p", deps: ["a"] },
      ] as any;

      // detectCycle is mocked; set its return to simulate cycle
      hoisted.detectCycleResult = "a";
      const cycle = hasCycle(nodes);
      expect(cycle).toBe("a");

      hoisted.detectCycleResult = null;
      const noCycle = hasCycle(nodes);
      expect(noCycle).toBe(null);
    });
  });
});
