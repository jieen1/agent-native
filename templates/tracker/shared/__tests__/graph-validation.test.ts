import { describe, expect, it } from "vitest";

import {
  validateDependencyGraph,
  type GraphEdge,
  type GraphNode,
} from "../graph-validation.js";

// Helper: build a node list from a list of itemKeys (id === itemKey for
// readability in these tests).
function nodes(keys: string[]): GraphNode[] {
  return keys.map((k) => ({ id: k, itemKey: k }));
}

// Helper: build an edge "A blocked-by B" (A depends on B).
function edge(fromId: string, toId: string): GraphEdge {
  return { fromId, toId };
}

describe("validateDependencyGraph", () => {
  // ── Self-dependency ──────────────────────────────────────────────────────

  it("reports self-dependency as an error", () => {
    const result = validateDependencyGraph(nodes(["A"]), [edge("A", "A")]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe("self-dependency");
    expect(result.errors[0].path).toEqual(["A"]);
  });

  // ── Cycle detection (造环→报环路径) ──────────────────────────────────────

  it("reports a cycle with its path when one exists", () => {
    // A blocked-by B, B blocked-by C, C blocked-by A → cycle A→B→C→A
    const result = validateDependencyGraph(nodes(["A", "B", "C"]), [
      edge("A", "B"),
      edge("B", "C"),
      edge("C", "A"),
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe("cycle");
    expect(result.errors[0].path).toBeDefined();
    // The path should start and end on the same node (closed loop) and
    // include all three participants.
    const path = result.errors[0].path!;
    expect(path[0]).toBe(path[path.length - 1]);
    expect(new Set(path)).toEqual(new Set(["A", "B", "C"]));
    // A cycle means no valid topological order.
    expect(result.topoOrder).toEqual([]);
  });

  it("does not attempt topo/chain/parallelism analysis when a cycle exists", () => {
    const result = validateDependencyGraph(nodes(["A", "B"]), [
      edge("A", "B"),
      edge("B", "A"),
    ]);
    expect(result.errors.some((e) => e.code === "cycle")).toBe(true);
    expect(result.topoOrder).toEqual([]);
    expect(result.warnings.some((w) => w.code === "chain-too-deep")).toBe(
      false,
    );
    expect(result.warnings.some((w) => w.code === "no-parallelism")).toBe(
      false,
    );
  });

  // ── Chain depth (深度4链→深度警告) ───────────────────────────────────────

  it("warns when the longest dependency chain has more than 3 nodes", () => {
    // A blocked-by B blocked-by C blocked-by D → chain depth 4 (A→B→C→D)
    const result = validateDependencyGraph(nodes(["A", "B", "C", "D"]), [
      edge("A", "B"),
      edge("B", "C"),
      edge("C", "D"),
    ]);
    expect(result.errors).toHaveLength(0);
    const warning = result.warnings.find((w) => w.code === "chain-too-deep");
    expect(warning).toBeDefined();
    expect(warning!.path).toEqual(["A", "B", "C", "D"]);
  });

  it("does not warn on chain depth for a 3-node chain (at the threshold)", () => {
    const result = validateDependencyGraph(nodes(["A", "B", "C"]), [
      edge("A", "B"),
      edge("B", "C"),
    ]);
    expect(result.warnings.some((w) => w.code === "chain-too-deep")).toBe(
      false,
    );
  });

  // ── No parallelism (完全线性→无并行度警告) ──────────────────────────────

  it('warns "no-parallelism" for a fully linear graph of 3+ nodes', () => {
    const result = validateDependencyGraph(nodes(["A", "B", "C"]), [
      edge("A", "B"),
      edge("B", "C"),
    ]);
    expect(result.warnings.some((w) => w.code === "no-parallelism")).toBe(true);
  });

  it('does not warn "no-parallelism" when the graph branches', () => {
    // A and B both depend on C — C has indegree 2, so not a single linear chain.
    const result = validateDependencyGraph(nodes(["A", "B", "C"]), [
      edge("A", "C"),
      edge("B", "C"),
    ]);
    expect(result.warnings.some((w) => w.code === "no-parallelism")).toBe(
      false,
    );
  });

  it('does not warn "no-parallelism" for fewer than 3 nodes', () => {
    const result = validateDependencyGraph(nodes(["A", "B"]), [edge("A", "B")]);
    expect(result.warnings.some((w) => w.code === "no-parallelism")).toBe(
      false,
    );
  });

  // ── Orphan nodes (孤儿→孤儿警告) ─────────────────────────────────────────

  it("warns on an orphan node with no dependencies and no dependents", () => {
    const result = validateDependencyGraph(nodes(["A", "B", "C"]), [
      edge("A", "B"),
    ]);
    const warning = result.warnings.find((w) => w.code === "orphan");
    expect(warning).toBeDefined();
    expect(warning!.path).toEqual(["C"]);
  });

  it("does not warn on orphans when fewer than 2 nodes exist", () => {
    const result = validateDependencyGraph(nodes(["A"]), []);
    expect(result.warnings.some((w) => w.code === "orphan")).toBe(false);
  });

  // ── Normal graph → correct topoOrder (正常图→topoOrder 正确) ────────────

  it("produces a correct, deterministic topological order for a valid DAG", () => {
    // D blocked-by B and C; B blocked-by A; C blocked-by A.
    // Valid orders: A,B,C,D or A,C,B,D — tie-break is itemKey-sorted so B
    // comes before C deterministically.
    const result = validateDependencyGraph(nodes(["D", "C", "B", "A"]), [
      edge("D", "B"),
      edge("D", "C"),
      edge("B", "A"),
      edge("C", "A"),
    ]);
    expect(result.errors).toHaveLength(0);
    expect(result.topoOrder).toEqual(["A", "B", "C", "D"]);
  });

  it("returns an empty-issue result for an empty graph", () => {
    const result = validateDependencyGraph([], []);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.topoOrder).toEqual([]);
  });

  it("returns a clean result (no errors/warnings) for a small valid graph with one edge", () => {
    const result = validateDependencyGraph(nodes(["A", "B"]), [edge("A", "B")]);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.topoOrder).toEqual(["B", "A"]);
  });
});
