// dag-layout — column-by-depth DAG layout (s7-run-detail parity).
//
// The independent acceptance review's most severe finding: DagVisualizer
// rendered every node as one continuous vertical line of cards, so real
// parallel siblings (e.g. gateStack/gateTests/gateNone fanning out from one
// upstream node) were visually indistinguishable from a serial chain. These
// tests pin the fix at the pure-layout level: siblings with no dependency
// path between them must land in the SAME column (parallel), while a strict
// chain must land in successive columns (serial) — using only real deps/edges
// data, never fabricated ordering.

import { describe, it, expect } from "vitest";

import { computeDagLayout, type DagLayoutNode } from "./dag-layout.js";

describe("computeDagLayout", () => {
  it("places a strict serial chain in successive columns, one node per column", () => {
    const nodes: DagLayoutNode[] = [
      { id: "workspace", type: "agent" },
      { id: "dev", type: "agent", deps: ["workspace"] },
      { id: "qa", type: "agent", deps: ["dev"] },
      { id: "reviewer", type: "agent", deps: ["qa"] },
    ];
    const layout = computeDagLayout(nodes, [
      { from: "workspace", to: "dev" },
      { from: "dev", to: "qa" },
      { from: "qa", to: "reviewer" },
    ]);

    expect(layout.columnCount).toBe(4);
    expect(layout.columns).toEqual([
      ["workspace"],
      ["dev"],
      ["qa"],
      ["reviewer"],
    ]);
    expect(layout.maxRows).toBe(1);
    expect(layout.parallelNodeIds.size).toBe(0);
  });

  it("places real DAG-parallel siblings (fanout from one node) in the SAME column, not a serial line", () => {
    // gateStack / gateTests / gateNone all depend only on `dev` and nothing
    // depends on one before another — the exact real-run shape called out by
    // the acceptance review.
    const nodes: DagLayoutNode[] = [
      { id: "workspace", type: "agent" },
      { id: "dev", type: "agent", deps: ["workspace"] },
      { id: "gateStack", type: "agent", deps: ["dev"] },
      { id: "gateTests", type: "agent", deps: ["dev"] },
      { id: "gateNone", type: "agent", deps: ["dev"] },
    ];
    const layout = computeDagLayout(nodes, [
      { from: "workspace", to: "dev" },
      { from: "dev", to: "gateStack" },
      { from: "dev", to: "gateTests" },
      { from: "dev", to: "gateNone" },
    ]);

    expect(layout.depthOf.get("gateStack")).toBe(2);
    expect(layout.depthOf.get("gateTests")).toBe(2);
    expect(layout.depthOf.get("gateNone")).toBe(2);
    // All three fanout siblings land in the SAME column (depth 2) — this is
    // the visual "parallel, not serial" signal the DAG canvas depends on.
    expect(layout.columns[2].sort()).toEqual([
      "gateNone",
      "gateStack",
      "gateTests",
    ]);
    expect(layout.maxRows).toBe(3);
    expect(layout.parallelNodeIds).toEqual(
      new Set(["gateStack", "gateTests", "gateNone"]),
    );
    // Serial nodes (workspace, dev) are NOT marked parallel.
    expect(layout.parallelNodeIds.has("workspace")).toBe(false);
    expect(layout.parallelNodeIds.has("dev")).toBe(false);
  });

  it("derives dependency depth from edges[] even when node.deps is absent", () => {
    const nodes: DagLayoutNode[] = [
      { id: "a", type: "agent" },
      { id: "b", type: "agent" },
    ];
    const layout = computeDagLayout(nodes, [{ from: "a", to: "b" }]);
    expect(layout.depthOf.get("a")).toBe(0);
    expect(layout.depthOf.get("b")).toBe(1);
  });

  it("merges deps[] and edges[] into one dependency set (a node depth-driven by the union)", () => {
    const nodes: DagLayoutNode[] = [
      { id: "a", type: "agent" },
      { id: "b", type: "agent" },
      // deps[] says only "a", but an edge also points from "z" — depth must
      // reflect BOTH sources since DagVisualizer reads both.
      { id: "z", type: "agent" },
      { id: "c", type: "agent", deps: ["a"] },
    ];
    const layout = computeDagLayout(nodes, [{ from: "z", to: "c" }]);
    expect(layout.depthOf.get("c")).toBe(1);
  });

  it("is cycle-safe (never infinite-loops on a malformed graph)", () => {
    const nodes: DagLayoutNode[] = [
      { id: "a", type: "agent", deps: ["b"] },
      { id: "b", type: "agent", deps: ["a"] },
    ];
    expect(() => computeDagLayout(nodes, [])).not.toThrow();
  });

  it("returns an empty layout for zero nodes", () => {
    const layout = computeDagLayout([], []);
    expect(layout.columnCount).toBe(0);
    expect(layout.columns).toEqual([]);
    expect(layout.maxRows).toBe(0);
  });
});
