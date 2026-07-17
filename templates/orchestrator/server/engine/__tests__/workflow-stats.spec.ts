// S8 workflow library (04-orchestrator.md §4) — pure aggregation/diff helpers
// backing the workflow library page's card stats, version-chain stats, and
// "对比任意两版" node diff. Kept DB-free and pure (see workflow-stats.ts's
// header) so these are tested directly, with no Drizzle mocking required.

import { describe, it, expect } from "vitest";
import { computeRunStats, diffDagNodes } from "../workflow-stats.js";

describe("computeRunStats", () => {
  it("returns runCount 0 and successRate null for an empty window", () => {
    expect(computeRunStats([])).toEqual({ runCount: 0, successRate: null });
  });

  it("counts every row toward runCount regardless of status", () => {
    const rows = [
      { status: "pending" },
      { status: "running" },
      { status: "done" },
    ];
    expect(computeRunStats(rows).runCount).toBe(3);
  });

  it("computes successRate only over TERMINAL runs (done/failed/cancelled)", () => {
    const rows = [
      { status: "done" },
      { status: "done" },
      { status: "failed" },
      { status: "pending" }, // excluded from the terminal denominator
      { status: "running" }, // excluded from the terminal denominator
    ];
    const stats = computeRunStats(rows);
    expect(stats.runCount).toBe(5);
    // 2 done / 3 terminal = 66.67% → rounds to 67
    expect(stats.successRate).toBe(67);
  });

  it("treats cancelled as terminal-but-not-success", () => {
    const rows = [{ status: "done" }, { status: "cancelled" }];
    expect(computeRunStats(rows).successRate).toBe(50);
  });

  it("returns successRate null when every run is still in-flight", () => {
    const rows = [{ status: "pending" }, { status: "running" }];
    expect(computeRunStats(rows)).toEqual({ runCount: 2, successRate: null });
  });

  it("100% success rounds cleanly", () => {
    const rows = [{ status: "done" }, { status: "done" }];
    expect(computeRunStats(rows).successRate).toBe(100);
  });
});

describe("diffDagNodes", () => {
  it("classifies added/removed/changed/unchanged node ids", () => {
    const before = [
      { id: "dev", agent: "vllm", prompt: "implement" },
      { id: "qa", agent: "vllm", prompt: "test" },
      { id: "pr", agent: "vllm", prompt: "open pr" },
    ];
    const after = [
      { id: "dev", agent: "vllm", prompt: "implement" }, // unchanged
      { id: "qa", agent: "vllm", prompt: "test with coverage" }, // changed
      // pr removed
      { id: "gate", agent: "vllm", prompt: "human gate" }, // added
    ];

    const diff = diffDagNodes(before, after);
    expect(diff.added).toEqual(["gate"]);
    expect(diff.removed).toEqual(["pr"]);
    expect(diff.changed).toEqual(["qa"]);
    expect(diff.unchanged).toEqual(["dev"]);
  });

  it("returns all-empty arrays for two identical node sets", () => {
    const nodes = [{ id: "a", x: 1 }, { id: "b", x: 2 }];
    const diff = diffDagNodes(nodes, nodes.map((n) => ({ ...n })));
    expect(diff).toEqual({
      added: [],
      removed: [],
      changed: [],
      unchanged: ["a", "b"],
    });
  });

  it("treats an entirely new node set as all-added, all-removed", () => {
    const before = [{ id: "a" }];
    const after = [{ id: "b" }];
    const diff = diffDagNodes(before, after);
    expect(diff.added).toEqual(["b"]);
    expect(diff.removed).toEqual(["a"]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged).toEqual([]);
  });
});
