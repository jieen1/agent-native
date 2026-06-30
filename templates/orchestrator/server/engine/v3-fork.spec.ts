// V3 Fork Unit Tests
//
// Tests forkRun: basic clone, fromNode reset, artifact reuse, tag merge.
// All DB queries are mocked.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

// ── Mock dependencies ───────────────────────────────────────────────────────

vi.mock("nanoid", () => ({
  customAlphabet: vi.fn(() => vi.fn(() => "abc123")),
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

interface MockSpawnRow {
  id: string;
  nodeId: string;
  attempt: number;
  agentName: string | null;
  engineRef: string | null;
  modelRef: string | null;
  runtime: string | null;
  workspaceId: string | null;
  renderedPrompt: string;
  logRef: string | null;
  vmName: string | null;
  acpSessionId: string | null;
  status: string;
  outputArtifactId: string | null;
  outputKind: string | null;
  tokensInput: number;
  tokensOutput: number;
  latencyMs: number | null;
  error: string | null;
  errorClass: string | null;
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
  objectContent: unknown;
  fullContentRef: string | null;
  byteSize: number | null;
  truncated: number;
  createdAt: Date;
  ownerEmail: string;
  orgId: string | null;
}

function createMockDb(
  run: MockRunRow,
  nodes: MockNodeRow[],
  spawns: MockSpawnRow[] = [],
  artifacts: MockArtifactRow[] = [],
  opts: { notFoundForRunId?: string } = {},
) {
  const insertedRuns: Array<Record<string, unknown>> = [];
  const insertedNodes: Array<Record<string, unknown>> = [];
  const insertedSpawns: Array<Record<string, unknown>> = [];
  const insertedArtifacts: Array<Record<string, unknown>> = [];

  const db = {
    select: () => ({
      from: (_table: unknown) => ({
        where: async (_filter: unknown) => {
          const table = _table as any;
          // v3Runs has templateId column, v3Nodes has nodeIdInDag
          if (table?.templateId !== undefined) {
            // Simulate eq filter for "not found" test
            if (opts.notFoundForRunId) return [];
            return [run];
          }
          if (table?.nodeIdInDag !== undefined) {
            return nodes;
          }
          if (table?.spawnId !== undefined) {
            return artifacts;
          }
          if (table?.renderedPrompt !== undefined) {
            return spawns;
          }
          return [];
        },
      }),
    }),
    insert: (_table: unknown) => ({
      values: async (rows: Record<string, unknown> | Record<string, unknown>[]) => {
        const table = _table as any;
        const rowArray = Array.isArray(rows) ? rows : [rows];
        for (const row of rowArray) {
          if (table?.templateId !== undefined) {
            insertedRuns.push(row as any);
          } else if (table?.nodeIdInDag !== undefined) {
            insertedNodes.push(row as any);
          } else if (table?.spawnId !== undefined) {
            insertedArtifacts.push(row as any);
          } else if (table?.renderedPrompt !== undefined) {
            insertedSpawns.push(row as any);
          }
        }
        return {};
      },
    }),
  } as unknown as PostgresJsDatabase;

  return {
    db,
    insertedRuns,
    insertedNodes,
    insertedSpawns,
    insertedArtifacts,
    resetSelectIndex: () => {},
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRun(overrides: Partial<MockRunRow> = {}): MockRunRow {
  return {
    id: "src-run",
    templateId: "tmpl-1",
    templateVersion: 1,
    inputs: { query: "hello" },
    dag: {
      nodes: [
        { id: "a", type: "agent", agent: "impl", prompt: "Do it", deps: [] },
        { id: "b", type: "agent", agent: "review", prompt: "Review", deps: ["a"] },
      ],
    },
    dagVersion: 1,
    status: "done",
    priority: 0,
    tags: { project: "alpha" },
    startedAt: new Date(),
    completedAt: new Date(),
    ownerEmail: "local@localhost",
    orgId: null,
    ...overrides,
  };
}

function makeNode(overrides: Partial<MockNodeRow> = {}): MockNodeRow {
  return {
    id: "src-node-a",
    runId: "src-run",
    nodeIdInDag: "a",
    type: "agent",
    status: "done",
    iteration: 0,
    fanoutIndex: 0,
    currentSpawnId: null,
    outputArtifactId: null,
    startedAt: new Date(),
    completedAt: new Date(),
    error: null,
    ownerEmail: "local@localhost",
    orgId: null,
    ...overrides,
  };
}

function makeSpawn(overrides: Partial<MockSpawnRow> = {}): MockSpawnRow {
  return {
    id: "src-spawn-1",
    nodeId: "src-node-a",
    attempt: 1,
    agentName: "impl",
    engineRef: null,
    modelRef: "claude-opus-4-5",
    runtime: "node",
    workspaceId: null,
    renderedPrompt: "Do it",
    logRef: null,
    vmName: null,
    acpSessionId: null,
    status: "done",
    outputArtifactId: "src-art-1",
    outputKind: "string",
    tokensInput: 100,
    tokensOutput: 200,
    latencyMs: 500,
    error: null,
    errorClass: null,
    tags: null,
    startedAt: new Date(),
    completedAt: new Date(),
    ownerEmail: "local@localhost",
    orgId: null,
    ...overrides,
  };
}

function makeArtifact(overrides: Partial<MockArtifactRow> = {}): MockArtifactRow {
  return {
    id: "src-art-1",
    spawnId: "src-spawn-1",
    kind: "string",
    textContent: "Implementation complete",
    objectContent: null,
    fullContentRef: null,
    byteSize: 23,
    truncated: 0,
    createdAt: new Date(),
    ownerEmail: "local@localhost",
    orgId: null,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("forkRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function getForkRun() {
    const mod = await import("./v3-fork.js");
    return mod.forkRun;
  }

  describe("Basic clone", () => {
    it("forkRun creates new run with cloned DAG and inputs", async () => {
      const forkRun = await getForkRun();
      const { db, insertedRuns, insertedNodes } = createMockDb(
        makeRun(),
        [makeNode({ nodeIdInDag: "a" }), makeNode({ nodeIdInDag: "b", id: "src-node-b" })],
      );

      const result = await forkRun(db, "src-run");

      expect(result.runId).toBeDefined();
      expect(result.runId.startsWith("run_")).toBe(true);

      expect(insertedRuns.length).toBe(1);
      const newRun = insertedRuns[0];
      expect(newRun.templateId).toBe("tmpl-1");
      expect(newRun.status).toBe("pending");
      expect(newRun.dagVersion).toBe(1);
      expect(newRun.inputs).toEqual({ query: "hello" });

      // Nodes should be cloned
      expect(insertedNodes.length).toBe(2);
      const forkNodeId = result.runId;
      for (const node of insertedNodes) {
        expect(node.runId).toBe(forkNodeId);
      }
    });

    it("forkRun throws when source run not found", async () => {
      const forkRun = await getForkRun();
      const { db } = createMockDb(makeRun(), [], [], [], { notFoundForRunId: "nonexistent" });

      await expect(forkRun(db, "nonexistent")).rejects.toThrow(
        "Source run not found: nonexistent",
      );
    });
  });

  describe("fromNode semantics", () => {
    it("fromNode resets target node and descendants to pending", async () => {
      const forkRun = await getForkRun();
      const { db, insertedNodes } = createMockDb(
        makeRun(),
        [
          makeNode({ nodeIdInDag: "a", id: "src-node-a", status: "done" }),
          makeNode({ nodeIdInDag: "b", id: "src-node-b", status: "done" }),
        ],
      );

      await forkRun(db, "src-run", { fromNode: "b" });

      // Node a (not in fromNode subtree) keeps done status
      const nodeA = insertedNodes.find((n) => n.nodeIdInDag === "a");
      expect(nodeA?.status).toBe("done");

      // Node b (fromNode) reset to pending
      const nodeB = insertedNodes.find((n) => n.nodeIdInDag === "b");
      expect(nodeB?.status).toBe("pending");
    });

    it("fromNode resets transitive descendants", async () => {
      const forkRun = await getForkRun();
      const { db, insertedNodes } = createMockDb(
        makeRun({
          dag: {
            nodes: [
              { id: "a", type: "agent", agent: "impl", prompt: "A", deps: [] },
              { id: "b", type: "agent", agent: "mid", prompt: "B", deps: ["a"] },
              { id: "c", type: "agent", agent: "end", prompt: "C", deps: ["b"] },
            ],
          },
        }),
        [
          makeNode({ nodeIdInDag: "a", id: "src-node-a", status: "done" }),
          makeNode({ nodeIdInDag: "b", id: "src-node-b", status: "done" }),
          makeNode({ nodeIdInDag: "c", id: "src-node-c", status: "done" }),
        ],
      );

      await forkRun(db, "src-run", { fromNode: "a" });

      // a is fromNode, so a, b, c all reset
      const nodeA = insertedNodes.find((n) => n.nodeIdInDag === "a");
      const nodeB = insertedNodes.find((n) => n.nodeIdInDag === "b");
      const nodeC = insertedNodes.find((n) => n.nodeIdInDag === "c");
      expect(nodeA?.status).toBe("pending");
      expect(nodeB?.status).toBe("pending");
      expect(nodeC?.status).toBe("pending");
    });

    it("without fromNode, resolved nodes keep their status (artifact cache)", async () => {
      const forkRun = await getForkRun();
      const { db, insertedNodes } = createMockDb(
        makeRun(),
        [
          makeNode({ nodeIdInDag: "a", status: "done" }),
        ],
      );

      await forkRun(db, "src-run");

      // Without fromNode, resolved nodes keep done status (artifact cache)
      for (const node of insertedNodes) {
        expect(node.status).toBe("done");
      }
    });
  });

  describe("Artifact reuse", () => {
    it("resolved nodes reuse artifacts when not in fromNode subtree", async () => {
      const forkRun = await getForkRun();
      const srcSpawn = makeSpawn();
      const srcArt = makeArtifact();
      const { db, insertedNodes, insertedSpawns, insertedArtifacts } =
        createMockDb(
          makeRun(),
          [
            makeNode({
              nodeIdInDag: "a",
              id: "src-node-a",
              status: "done",
              currentSpawnId: "src-spawn-1",
              outputArtifactId: "src-art-1",
            }),
          ],
          [srcSpawn],
          [srcArt],
        );

      await forkRun(db, "src-run", { fromNode: "b" });

      const nodeA = insertedNodes.find((n) => n.nodeIdInDag === "a");
      expect(nodeA?.status).toBe("done");

      // Spawn and artifact should be cloned for resolved node a
      expect(insertedSpawns.length).toBe(1);
      expect(insertedArtifacts.length).toBe(1);

      const clonedSpawn = insertedSpawns[0];
      expect(clonedSpawn.workspaceId).toBe(null); // fork does not clone workspace

      const clonedArt = insertedArtifacts[0];
      expect(clonedArt.kind).toBe("string");
    });
  });

  describe("Tag merge", () => {
    it("mergeTags preserves source tags and overwrites with extra", async () => {
      const forkRun = await getForkRun();
      const { db, insertedRuns } = createMockDb(
        makeRun({ tags: { project: "alpha", env: "dev" } }),
        [makeNode({ nodeIdInDag: "a" })],
      );

      await forkRun(db, "src-run", {
        extraTags: { env: "prod", region: "us" },
      });

      expect(insertedRuns.length).toBe(1);
      const tags = insertedRuns[0].tags as Record<string, string>;
      expect(tags).toEqual({
        project: "alpha", // preserved from source
        env: "prod", // overridden by extraTags
        region: "us", // added from extraTags
      });
    });

    it("mergeTags handles null source tags", async () => {
      const forkRun = await getForkRun();
      const { db, insertedRuns } = createMockDb(
        makeRun({ tags: null }),
        [makeNode({ nodeIdInDag: "a" })],
      );

      await forkRun(db, "src-run", {
        extraTags: { env: "prod" },
      });

      const tags = insertedRuns[0].tags as Record<string, string>;
      expect(tags).toEqual({ env: "prod" });
    });

    it("mergeTags returns null when both source and extra are empty", async () => {
      const forkRun = await getForkRun();
      const { db, insertedRuns } = createMockDb(
        makeRun({ tags: null }),
        [makeNode({ nodeIdInDag: "a" })],
      );

      await forkRun(db, "src-run");

      // No extraTags, no sourceTags -> null
      expect(insertedRuns[0].tags).toBeNull();
    });
  });

  describe("Input override", () => {
    it("overrideInputs merges into source inputs", async () => {
      const forkRun = await getForkRun();
      const { db, insertedRuns } = createMockDb(
        makeRun({ inputs: { query: "hello", lang: "en" } }),
        [makeNode({ nodeIdInDag: "a" })],
      );

      await forkRun(db, "src-run", {
        overrideInputs: { query: "updated" },
      });

      const inputs = insertedRuns[0].inputs as Record<string, unknown>;
      expect(inputs).toEqual({
        query: "updated", // overridden
        lang: "en", // preserved
      });
    });
  });
});
