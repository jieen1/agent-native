// F2 executor context management — checkpoint extraction + persistence
// (SDLC docs §2A/§6.2 T-F2-01, T-F2-07). Pure-function tests for the
// extractor/merger plus a mocked-DB test for the best-effort persist path.

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { RuntimeExecStep } from "../types.js";

// ── Mock the DB module BEFORE importing the module under test's persist path ─
// context-checkpoint.ts dynamically imports "../../db/index.js" (relative to
// server/runtime/executors/context-checkpoint.ts) — from this spec file
// (server/runtime/executors/__tests__/) that resolves to "../../../db/index.js".
const hoisted = vi.hoisted(() => ({
  mockDb: null as unknown as {
    select: () => unknown;
    update: () => unknown;
  },
  v3Schema: {
    v3Spawns: {
      nodeId: "node_id_column",
      status: "status_column",
      contextCheckpoint: "context_checkpoint_column",
    },
  },
}));

vi.mock("../../../db/index.js", () => ({
  getV3Db: () => hoisted.mockDb,
  v3Schema: hoisted.v3Schema,
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (column: unknown, value: unknown) => ({ eq: [column, value] }),
}));

import {
  extractWrittenFiles,
  buildContextCheckpoint,
  mergeContextCheckpoints,
  persistContextCheckpoint,
  type ContextCheckpoint,
} from "../context-checkpoint.js";

// ── Step fixtures ────────────────────────────────────────────────────────────

function toolUse(name: string, input: unknown, seq: number): RuntimeExecStep {
  return { seq, type: "tool_use", name, input };
}
function toolResult(name: string, result: string, seq: number): RuntimeExecStep {
  return { seq, type: "tool_result", name, result };
}
function textStep(text: string, seq: number): RuntimeExecStep {
  return { seq, type: "text", text };
}

describe("extractWrittenFiles (T-F2-01)", () => {
  it("returns only successfully written/edited files; failures and bash are excluded", () => {
    const steps: RuntimeExecStep[] = [
      toolUse("bash", { command: "ls" }, 0),
      toolResult("bash", "a.ts\nb.ts", 1),
      toolUse("write", { filePath: "a.ts", content: "x" }, 2),
      toolResult("write", "Wrote a.ts (1 line).", 3),
      toolUse("edit", { filePath: "b.ts" }, 4),
      toolResult("edit", "Error: cannot edit b.ts (read failed): ENOENT", 5),
      toolUse("write", { filePath: "c.ts", content: "y" }, 6),
      toolResult("write", "Error: cannot write c.ts: disk full", 7),
      toolUse("edit", { filePath: "d.ts" }, 8),
      toolResult("edit", "Edited d.ts (2 replacements).", 9),
    ];

    expect(extractWrittenFiles(steps)).toEqual(["a.ts", "d.ts"]);
  });

  it("de-duplicates repeated successful writes to the same file, preserving first-seen order", () => {
    const steps: RuntimeExecStep[] = [
      toolUse("write", { filePath: "a.ts" }, 0),
      toolResult("write", "Wrote a.ts (1 line).", 1),
      toolUse("edit", { filePath: "b.ts" }, 2),
      toolResult("edit", "Edited b.ts (1 replacement).", 3),
      toolUse("write", { filePath: "a.ts" }, 4),
      toolResult("write", "Wrote a.ts (2 lines).", 5),
    ];

    expect(extractWrittenFiles(steps)).toEqual(["a.ts", "b.ts"]);
  });

  it("ignores an unmatched tool_result (no pending tool_use for that name)", () => {
    const steps: RuntimeExecStep[] = [
      toolResult("write", "Wrote orphan.ts (1 line).", 0),
    ];
    expect(extractWrittenFiles(steps)).toEqual([]);
  });

  it("returns an empty list for a transcript with no write/edit calls", () => {
    const steps: RuntimeExecStep[] = [
      toolUse("bash", { command: "pnpm test" }, 0),
      toolResult("bash", "ok", 1),
      textStep("done", 2),
    ];
    expect(extractWrittenFiles(steps)).toEqual([]);
  });
});

describe("buildContextCheckpoint", () => {
  it("prefers finalText for the remaining-tasks summary when present", () => {
    const steps: RuntimeExecStep[] = [
      toolUse("write", { filePath: "a.ts" }, 0),
      toolResult("write", "Wrote a.ts (1 line).", 1),
    ];
    const checkpoint = buildContextCheckpoint({
      steps,
      finalText: "Implemented the feature; tests still pending.",
    });
    expect(checkpoint.writtenFiles).toEqual(["a.ts"]);
    expect(checkpoint.remainingTasksSummary).toBe(
      "Implemented the feature; tests still pending.",
    );
    expect(typeof checkpoint.updatedAt).toBe("string");
  });

  it("falls back to the last non-empty text step when finalText is empty", () => {
    const steps: RuntimeExecStep[] = [
      textStep("first thought", 0),
      toolUse("write", { filePath: "a.ts" }, 1),
      toolResult("write", "Wrote a.ts (1 line).", 2),
      textStep("last observed reasoning before cutoff", 3),
    ];
    const checkpoint = buildContextCheckpoint({ steps, finalText: "" });
    expect(checkpoint.remainingTasksSummary).toBe(
      "last observed reasoning before cutoff",
    );
  });

  it("is null when there is neither finalText nor any text step", () => {
    const steps: RuntimeExecStep[] = [
      toolUse("write", { filePath: "a.ts" }, 0),
      toolResult("write", "Wrote a.ts (1 line).", 1),
    ];
    const checkpoint = buildContextCheckpoint({ steps });
    expect(checkpoint.remainingTasksSummary).toBeNull();
  });
});

describe("mergeContextCheckpoints (T-F2-07 — only grows, never overwrites away)", () => {
  it("returns the next checkpoint unchanged when there is no previous one", () => {
    const next: ContextCheckpoint = {
      writtenFiles: ["a.ts"],
      remainingTasksSummary: "keep going",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(mergeContextCheckpoints(null, next)).toEqual(next);
  });

  it("unions written files instead of dropping the previous attempt's list", () => {
    const previous: ContextCheckpoint = {
      writtenFiles: ["a.ts", "b.ts"],
      remainingTasksSummary: "old summary",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const next: ContextCheckpoint = {
      writtenFiles: ["b.ts", "c.ts"],
      remainingTasksSummary: "new summary",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    const merged = mergeContextCheckpoints(previous, next);
    expect(merged.writtenFiles).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(merged.remainingTasksSummary).toBe("new summary");
    expect(merged.updatedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("keeps the previous summary when the next attempt has none", () => {
    const previous: ContextCheckpoint = {
      writtenFiles: ["a.ts"],
      remainingTasksSummary: "old summary",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const next: ContextCheckpoint = {
      writtenFiles: [],
      remainingTasksSummary: null,
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    const merged = mergeContextCheckpoints(previous, next);
    expect(merged.writtenFiles).toEqual(["a.ts"]);
    expect(merged.remainingTasksSummary).toBe("old summary");
  });
});

describe("persistContextCheckpoint (mocked DB — T-F2-07 duplicate-termination path)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createMockDb(existing: { contextCheckpoint: unknown } | null) {
    const setCalls: Array<Record<string, unknown>> = [];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => (existing ? [existing] : []),
          }),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          setCalls.push(values);
          return { where: async () => ({}) };
        },
      }),
    };
    return { db, setCalls };
  }

  it("writes the checkpoint when no row/checkpoint exists yet", async () => {
    const { db, setCalls } = createMockDb(null);
    hoisted.mockDb = db as never;

    await persistContextCheckpoint({
      nodeId: "node-1",
      checkpoint: {
        writtenFiles: ["a.ts"],
        remainingTasksSummary: "keep going",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(setCalls).toHaveLength(1);
    const written = setCalls[0].contextCheckpoint as ContextCheckpoint;
    expect(written.writtenFiles).toEqual(["a.ts"]);
  });

  it("merges with an existing checkpoint instead of overwriting it away (duplicate termination)", async () => {
    const { db, setCalls } = createMockDb({
      contextCheckpoint: {
        writtenFiles: ["already-done.ts"],
        remainingTasksSummary: "first summary",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    hoisted.mockDb = db as never;

    await persistContextCheckpoint({
      nodeId: "node-1",
      checkpoint: {
        writtenFiles: [],
        remainingTasksSummary: null,
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    });

    expect(setCalls).toHaveLength(1);
    const written = setCalls[0].contextCheckpoint as ContextCheckpoint;
    // The earlier attempt's file must survive a later, emptier termination call.
    expect(written.writtenFiles).toEqual(["already-done.ts"]);
    expect(written.remainingTasksSummary).toBe("first summary");
  });

  it("never throws when the DB layer fails (best-effort)", async () => {
    hoisted.mockDb = {
      select: () => {
        throw new Error("connection refused");
      },
      update: () => ({ set: () => ({ where: async () => ({}) }) }),
    } as never;

    await expect(
      persistContextCheckpoint({
        nodeId: "node-1",
        checkpoint: {
          writtenFiles: ["a.ts"],
          remainingTasksSummary: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("is a no-op when nodeId is empty", async () => {
    const { db, setCalls } = createMockDb(null);
    hoisted.mockDb = db as never;

    await persistContextCheckpoint({
      nodeId: "",
      checkpoint: {
        writtenFiles: ["a.ts"],
        remainingTasksSummary: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(setCalls).toHaveLength(0);
  });
});
