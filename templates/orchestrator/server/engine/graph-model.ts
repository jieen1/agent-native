// Structural analysis of a WorkflowGraph the scheduler needs (DESIGN §3 / §4.1a).
// Pure functions over the static template graph: containment (which container a
// node belongs to), edge adjacency, and the nearest-upstream-fanout for a join.
// No run state, no clock — just topology.

import type { Edge, Node, WorkflowGraph } from "../../shared/types.js";

export interface GraphModel {
  nodes: Node[];
  edges: Edge[];
  byId: Map<string, Node>;
  /** node id -> ids of its direct successors (edge from→to). */
  out: Map<string, string[]>;
  /** node id -> ids of its direct predecessors. */
  in: Map<string, string[]>;
  /** node id -> the container node id that lists it in `children`, or null. */
  containerOf: Map<string, string | null>;
  /** container id -> its child node ids (from `children`). */
  childrenOf: Map<string, string[]>;
}

export function buildGraphModel(graph: WorkflowGraph): GraphModel {
  const byId = new Map<string, Node>(graph.nodes.map((n) => [n.id, n]));
  const out = new Map<string, string[]>();
  const inn = new Map<string, string[]>();
  for (const n of graph.nodes) {
    out.set(n.id, []);
    inn.set(n.id, []);
  }
  for (const e of graph.edges) {
    if (byId.has(e.from) && byId.has(e.to)) {
      out.get(e.from)!.push(e.to);
      inn.get(e.to)!.push(e.from);
    }
  }
  const containerOf = new Map<string, string | null>();
  const childrenOf = new Map<string, string[]>();
  for (const n of graph.nodes) containerOf.set(n.id, null);
  for (const n of graph.nodes) {
    if (Array.isArray(n.children) && n.children.length > 0) {
      childrenOf.set(n.id, n.children.slice());
      for (const c of n.children) {
        if (byId.has(c)) containerOf.set(c, n.id);
      }
    }
  }
  return { nodes: graph.nodes, edges: graph.edges, byId, out, in: inn, containerOf, childrenOf };
}

/** Edges leaving a node (with their `when`). */
export function outEdges(g: GraphModel, nodeId: string): Edge[] {
  return g.edges.filter((e) => e.from === nodeId && g.byId.has(e.to));
}

/** Edges entering a node. */
export function inEdges(g: GraphModel, nodeId: string): Edge[] {
  return g.edges.filter((e) => e.to === nodeId && g.byId.has(e.from));
}

/**
 * The fanout container a node belongs to (walking up `children` containment),
 * or null if the node is not inside any fanout. A node inside a parallel that
 * is itself inside a fanout still belongs to that fanout for index purposes.
 */
export function enclosingFanout(g: GraphModel, nodeId: string): string | null {
  let cur = g.containerOf.get(nodeId) ?? null;
  while (cur) {
    if (g.byId.get(cur)?.type === "fanout") return cur;
    cur = g.containerOf.get(cur) ?? null;
  }
  return null;
}

/**
 * Nearest upstream fanout for a join (DESIGN §4.1a): reverse-BFS over edges
 * until a fanout container is reached. Returns the single fanout id (the
 * validator already rejects a join reachable from >1 distinct fanout), or null.
 */
export function nearestUpstreamFanout(
  g: GraphModel,
  joinId: string,
): string | null {
  // A join synchronizes the items of the fanout whose children feed it. The
  // children that feed it are fanout-scoped; their enclosing fanout is the one
  // we seal against.
  const preds = g.in.get(joinId) ?? [];
  for (const p of preds) {
    const f = enclosingFanout(g, p);
    if (f) return f;
    if (g.byId.get(p)?.type === "fanout") return p;
  }
  // Fall back to a reverse walk for indirect cases.
  const seen = new Set<string>([joinId]);
  const stack = [...preds];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (g.byId.get(cur)?.type === "fanout") return cur;
    const f = enclosingFanout(g, cur);
    if (f) return f;
    for (const pp of g.in.get(cur) ?? []) stack.push(pp);
  }
  return null;
}
