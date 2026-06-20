import { describe, it, expect } from "vitest";
import { validateGraph, type TemplateResolver } from "./graph-validator.js";
import {
  parseGraph,
  type Condition,
  type Edge,
  type Node,
  type WorkflowGraph,
} from "./types.js";

// ---------------------------------------------------------------------------
// Tiny fixture helpers. Each test builds the SMALLEST graph that is valid
// except for the one rule under test, so an assertion isolates that rule.
// ---------------------------------------------------------------------------

function n(id: string, type: Node["type"], extra: Partial<Node> = {}): Node {
  return { id, type, title: id, ...extra };
}

function e(from: string, to: string, when?: Condition): Edge {
  return { id: `${from}->${to}`, from, to, ...(when ? { when } : {}) };
}

const JSONPATH_COND: Condition = {
  kind: "jsonpath",
  path: "deps.x.output.score",
  op: ">=",
  value: 8,
};

/** A minimal fully-valid graph: start → agent → end. */
function validGraph(): WorkflowGraph {
  return {
    nodes: [n("start", "start"), n("a", "agent"), n("end", "end")],
    edges: [e("start", "a"), e("a", "end")],
  };
}

describe("validateGraph — valid baseline", () => {
  it("a well-formed start → agent → end graph passes with no errors", () => {
    const res = validateGraph(validGraph());
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it("parseGraph round-trips a graph that then validates clean", () => {
    const parsed = parseGraph(JSON.stringify(validGraph()));
    expect(parsed.nodes).toHaveLength(3);
    expect(parsed.edges).toHaveLength(2);
    const res = validateGraph(parsed);
    expect(res.ok).toBe(true);
  });
});

describe("validateGraph — ERROR rules (block save)", () => {
  it("cyclic base graph errors (loops must be loop NODES, not back-edges)", () => {
    const graph: WorkflowGraph = {
      nodes: [
        n("start", "start"),
        n("a", "agent"),
        n("b", "agent"),
        n("end", "end"),
      ],
      // a → b → a is a back-edge cycle.
      edges: [e("start", "a"), e("a", "b"), e("b", "a"), e("a", "end")],
    };
    const res = validateGraph(graph);
    expect(res.ok).toBe(false);
    expect(res.errors.some((m) => m.toLowerCase().includes("cycle"))).toBe(
      true,
    );
  });

  it("missing start errors", () => {
    const graph: WorkflowGraph = {
      nodes: [n("a", "agent"), n("end", "end")],
      edges: [e("a", "end")],
    };
    const res = validateGraph(graph);
    expect(res.ok).toBe(false);
    expect(res.errors.some((m) => m.includes("exactly one 'start'"))).toBe(
      true,
    );
  });

  it("duplicate start errors", () => {
    const graph: WorkflowGraph = {
      nodes: [n("start", "start"), n("start2", "start"), n("end", "end")],
      edges: [e("start", "end"), e("start2", "end")],
    };
    const res = validateGraph(graph);
    expect(res.ok).toBe(false);
    expect(res.errors.some((m) => m.includes("exactly one 'start'"))).toBe(
      true,
    );
  });

  it("missing end errors", () => {
    const graph: WorkflowGraph = {
      nodes: [n("start", "start"), n("a", "agent")],
      edges: [e("start", "a")],
    };
    const res = validateGraph(graph);
    expect(res.ok).toBe(false);
    expect(res.errors.some((m) => m.includes("exactly one 'end'"))).toBe(true);
  });

  it("duplicate end errors", () => {
    const graph: WorkflowGraph = {
      nodes: [n("start", "start"), n("end", "end"), n("end2", "end")],
      edges: [e("start", "end"), e("start", "end2")],
    };
    const res = validateGraph(graph);
    expect(res.ok).toBe(false);
    expect(res.errors.some((m) => m.includes("exactly one 'end'"))).toBe(true);
  });

  it("fanout with bad itemsFrom errors", () => {
    const graph: WorkflowGraph = {
      nodes: [
        n("start", "start"),
        n("disco", "agent"),
        n("fan", "fanout", { itemsFrom: "does-not-exist" }),
        n("end", "end"),
      ],
      edges: [e("start", "disco"), e("disco", "fan"), e("fan", "end")],
    };
    const res = validateGraph(graph);
    expect(res.ok).toBe(false);
    expect(
      res.errors.some((m) => m.includes("fan") && m.includes("does-not-exist")),
    ).toBe(true);
  });

  it("loop missing condition errors", () => {
    const graph: WorkflowGraph = {
      nodes: [
        n("start", "start"),
        // maxIterations present, condition absent.
        n("lp", "loop", { maxIterations: 5 }),
        n("end", "end"),
      ],
      edges: [e("start", "lp"), e("lp", "end")],
    };
    const res = validateGraph(graph);
    expect(res.ok).toBe(false);
    expect(
      res.errors.some((m) => m.includes("lp") && m.includes("condition")),
    ).toBe(true);
  });

  it("loop missing maxIterations errors", () => {
    const graph: WorkflowGraph = {
      nodes: [
        n("start", "start"),
        // condition present, maxIterations absent.
        n("lp", "loop", { condition: JSONPATH_COND }),
        n("end", "end"),
      ],
      edges: [e("start", "lp"), e("lp", "end")],
    };
    const res = validateGraph(graph);
    expect(res.ok).toBe(false);
    expect(
      res.errors.some((m) => m.includes("lp") && m.includes("maxIterations")),
    ).toBe(true);
  });

  it("branch out-edge missing when errors", () => {
    const graph: WorkflowGraph = {
      nodes: [
        n("start", "start"),
        n("br", "branch"),
        n("yes", "agent"),
        n("no", "agent"),
        n("end", "end"),
      ],
      edges: [
        e("start", "br"),
        e("br", "yes", JSONPATH_COND), // has when
        e("br", "no"), // MISSING when
        e("yes", "end"),
        e("no", "end"),
      ],
    };
    const res = validateGraph(graph);
    expect(res.ok).toBe(false);
    expect(res.errors.some((m) => m.includes("br") && m.includes("when"))).toBe(
      true,
    );
  });

  it("subworkflow missing templateRef errors", () => {
    const graph: WorkflowGraph = {
      nodes: [
        n("start", "start"),
        n("sub", "subworkflow"), // no templateRef
        n("end", "end"),
      ],
      edges: [e("start", "sub"), e("sub", "end")],
    };
    const res = validateGraph(graph);
    expect(res.ok).toBe(false);
    expect(
      res.errors.some((m) => m.includes("sub") && m.includes("templateRef")),
    ).toBe(true);
  });

  it("two-level subworkflow nesting is rejected when a resolver is provided", () => {
    // The referenced template itself contains a subworkflow node → two levels.
    const innerTemplate: WorkflowGraph = {
      nodes: [
        n("istart", "start"),
        n("inner-sub", "subworkflow", { templateRef: "deep" }),
        n("iend", "end"),
      ],
      edges: [e("istart", "inner-sub"), e("inner-sub", "iend")],
    };
    const resolver: TemplateResolver = (ref) =>
      ref === "child" ? innerTemplate : null;

    const graph: WorkflowGraph = {
      nodes: [
        n("start", "start"),
        n("sub", "subworkflow", { templateRef: "child" }),
        n("end", "end"),
      ],
      edges: [e("start", "sub"), e("sub", "end")],
    };
    const res = validateGraph(graph, { templateResolver: resolver });
    expect(res.ok).toBe(false);
    expect(res.errors.some((m) => m.includes("two-level nesting"))).toBe(true);
  });

  it("a one-level subworkflow passes when the resolver returns a flat template", () => {
    const flatTemplate: WorkflowGraph = {
      nodes: [n("istart", "start"), n("iwork", "agent"), n("iend", "end")],
      edges: [e("istart", "iwork"), e("iwork", "iend")],
    };
    const resolver: TemplateResolver = (ref) =>
      ref === "child" ? flatTemplate : null;
    const graph: WorkflowGraph = {
      nodes: [
        n("start", "start"),
        n("sub", "subworkflow", { templateRef: "child" }),
        n("end", "end"),
      ],
      edges: [e("start", "sub"), e("sub", "end")],
    };
    const res = validateGraph(graph, { templateResolver: resolver });
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it("join reachable from 2 distinct fanouts errors (§4.1a)", () => {
    // Two separate discovery→fanout chains both feed one join.
    const graph: WorkflowGraph = {
      nodes: [
        n("start", "start"),
        n("discoA", "agent"),
        n("fanA", "fanout", { itemsFrom: "discoA" }),
        n("workA", "agent"),
        n("discoB", "agent"),
        n("fanB", "fanout", { itemsFrom: "discoB" }),
        n("workB", "agent"),
        n("join", "join"),
        n("end", "end"),
      ],
      edges: [
        e("start", "discoA"),
        e("discoA", "fanA"),
        e("fanA", "workA"),
        e("workA", "join"),
        e("start", "discoB"),
        e("discoB", "fanB"),
        e("fanB", "workB"),
        e("workB", "join"),
        e("join", "end"),
      ],
    };
    const res = validateGraph(graph);
    expect(res.ok).toBe(false);
    expect(
      res.errors.some(
        (m) => m.includes("join") && m.includes("2 distinct fanout"),
      ),
    ).toBe(true);
  });

  it("a join under a SINGLE fanout (two inbound branches) does NOT error", () => {
    // One fanout, two work branches merge at the join → legal cardinality.
    const graph: WorkflowGraph = {
      nodes: [
        n("start", "start"),
        n("disco", "agent"),
        n("fan", "fanout", { itemsFrom: "disco" }),
        n("w1", "agent"),
        n("w2", "agent"),
        n("join", "join"),
        n("end", "end"),
      ],
      edges: [
        e("start", "disco"),
        e("disco", "fan"),
        e("fan", "w1"),
        e("fan", "w2"),
        e("w1", "join"),
        e("w2", "join"),
        e("join", "end"),
      ],
    };
    const res = validateGraph(graph);
    // No fanout-cardinality error; this join has 2 inbound edges so no
    // implicit-barrier warning either.
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });
});

describe("validateGraph — WARNING rules (do NOT block)", () => {
  it("an implicit-barrier join (single inbound edge) warns but ok:true", () => {
    // start → fan(itemsFrom disco)… simplest: a join with exactly one inbound.
    const graph: WorkflowGraph = {
      nodes: [
        n("start", "start"),
        n("disco", "agent"),
        n("fan", "fanout", { itemsFrom: "disco" }),
        n("work", "agent"),
        n("join", "join"),
        n("end", "end"),
      ],
      edges: [
        e("start", "disco"),
        e("disco", "fan"),
        e("fan", "work"),
        e("work", "join"), // join has exactly ONE inbound edge
        e("join", "end"),
      ],
    };
    const res = validateGraph(graph);
    // It is NOT an error — the run is still saveable.
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
    // …but it IS flagged as a likely-unintended barrier.
    expect(
      res.warnings.some(
        (m) => m.includes("join") && m.toLowerCase().includes("barrier"),
      ),
    ).toBe(true);
  });
});
