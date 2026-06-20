// Promote a successful run → reusable template (DESIGN §6.5 "promote-run-to-
// template"). The distillation is pure and deterministic: it reads a run's
// ACTUAL executed NodeRuns and the template the run instantiated, then collapses
// the dynamic run instance back into a static authored graph.
//
// Collapse rules (DESIGN §6.5):
//   - Dynamic fanout indices collapse to ONE node per logical `nodeId`: every
//     NodeRun for `(nodeId, *, *)` — all fanoutIndices and loop iterations —
//     folds into a single distilled node. Genuine fanout is preserved as a
//     `fanout` container node; only the per-item *indices* disappear.
//   - The node/edge SET equals the execution topology: a distilled node exists
//     iff some NodeRun executed it; a distilled edge `A→B` exists iff the
//     template wired `A→B` and BOTH endpoints executed. (Index-preserving
//     fanout edges `A_i→B_i` were always authored as `A→B`, so restricting the
//     template edges to executed node ids recovers exactly the run topology.)
//   - Key config is carried from the template node (prompt/runtime/effort/…),
//     which is the authored source of truth; observed routing (engine/model)
//     from the journal is layered on so a per-run override is captured.
//
// Re-running the distilled template reaches the same SHAPE without dynamic
// expansion beyond genuine fanout — because the distilled graph IS the static
// shape the run executed.

import type { Edge, Node, WorkflowGraph } from "../../shared/types.js";

/** The minimal NodeRun projection the distiller needs (journal columns). */
export interface DistillNodeRun {
  nodeId: string;
  type: string;
  title: string;
  assignee: string | null;
  engine: string | null;
  model: string | null;
  iteration: number;
  fanoutIndex: number;
  dynamic: number | boolean;
}

/** The result of distilling a run into a template graph + a small report. */
export interface DistilledTemplate {
  graph: WorkflowGraph;
  /** nodeIds that executed (the distilled node set). */
  nodeIds: string[];
  /** How many raw NodeRuns collapsed into each distilled node. */
  collapsed: Record<string, number>;
}

/**
 * Distill a run's executed NodeRuns + the template it ran into a new static
 * template graph (DESIGN §6.5). Pure: no DB, no clock — given the same inputs it
 * always produces the same graph, so the result is testable by set-equality.
 */
export function distillRun(
  template: WorkflowGraph,
  nodeRuns: DistillNodeRun[],
): DistilledTemplate {
  const templateById = new Map<string, Node>(
    template.nodes.map((n) => [n.id, n]),
  );

  // 1. The executed node set: one entry per distinct logical nodeId, regardless
  //    of how many (iteration, fanoutIndex) instances ran. Inline-subworkflow
  //    children are namespaced (`sub::child`) in the journal; they collapse to
  //    their own distilled node by that namespaced id.
  const collapsed: Record<string, number> = {};
  const firstSeen = new Map<string, DistillNodeRun>();
  const order: string[] = [];
  for (const nr of nodeRuns) {
    collapsed[nr.nodeId] = (collapsed[nr.nodeId] ?? 0) + 1;
    if (!firstSeen.has(nr.nodeId)) {
      firstSeen.set(nr.nodeId, nr);
      order.push(nr.nodeId);
    }
  }
  const executed = new Set(order);

  // 2. Distill each executed nodeId into one node. Prefer the authored template
  //    node (full config: prompt/runtime/effort/children/itemsFrom/…); fall
  //    back to the journal projection for dynamically-spliced nodes that are
  //    not in the template. Observed routing overrides are layered on.
  const nodes: Node[] = order.map((id) => {
    const tpl = templateById.get(id);
    const obs = firstSeen.get(id)!;
    if (tpl) {
      const node: Node = { ...tpl };
      // Capture a per-run routing override the journal recorded (node-override).
      if (obs.engine) node.engine = obs.engine;
      if (obs.model) node.model = obs.model;
      // Drop container child refs that did not execute (a collapsed/never-taken
      // branch leaves a stale child), so the distilled graph stays consistent.
      if (Array.isArray(node.children)) {
        const kept = node.children.filter((c) => executed.has(c));
        if (kept.length > 0) node.children = kept;
        else delete node.children;
      }
      return node;
    }
    // Dynamically-spliced node not present in the template: rebuild from the
    // journal projection (type/title/routing only — its config is whatever ran).
    const node: Node = {
      id,
      type: obs.type as Node["type"],
      title: obs.title || id,
    };
    if (obs.assignee) node.assignee = obs.assignee;
    if (obs.engine) node.engine = obs.engine;
    if (obs.model) node.model = obs.model;
    return node;
  });

  // 3. Distill edges: keep every template edge whose BOTH endpoints executed.
  //    Index-preserving fanout edges were authored as A→B, so this recovers the
  //    run's collapsed topology exactly. De-dupe by (from,to,when) so a repeated
  //    edge cannot slip in.
  const seenEdge = new Set<string>();
  const edges: Edge[] = [];
  for (const e of template.edges) {
    if (!executed.has(e.from) || !executed.has(e.to)) continue;
    const sig = `${e.from}->${e.to}#${e.when ? JSON.stringify(e.when) : ""}`;
    if (seenEdge.has(sig)) continue;
    seenEdge.add(sig);
    edges.push(e.when ? { ...e } : { id: e.id, from: e.from, to: e.to });
  }

  return { graph: { nodes, edges }, nodeIds: order, collapsed };
}
