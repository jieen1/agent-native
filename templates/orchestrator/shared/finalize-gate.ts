// ===========================================================================
// finalize-status GATE — STRUCTURAL injection (DESIGN §6.2b layer 1 / §3.7).
//
// Every DELIVERY workflow must end, RIGHT BEFORE `end`, with a `finalize-status`
// library node. This module owns the PURE graph surgery: detect whether a graph
// already has the gate and, if not, AUTO-INJECT it between the node(s) feeding
// `end` and `end` itself — exactly like a required `git-push` gate the brain
// cannot omit. The injected node references the library by `nodeDefKey` so its
// behavior is the vetted library config, not an inline guess.
//
// PURE (no DB, no IO): both `save-template` (server) and the headless proof call
// this. The RUNTIME assertion ("did the agent actually move status?") lives in
// `server/work-items/finalize-gate.ts`; this file only guarantees the node is
// STRUCTURALLY present so the run cannot finish without passing through it.
// ===========================================================================

import type { Edge, Node, WorkflowGraph } from "./types.js";

/** The library `key` of the finalize-status gate node (DESIGN §3.7). */
export const FINALIZE_STATUS_KEY = "finalize-status";

/** The action a finalize-status tool node wraps (the runtime assertion seam). */
export const FINALIZE_STATUS_ACTION = "finalize-status";

/** True when `node` IS the finalize-status gate (by library key or action). */
export function isFinalizeStatusNode(node: Node): boolean {
  return (
    node.nodeDefKey === FINALIZE_STATUS_KEY ||
    (node.type === "tool" && node.action === FINALIZE_STATUS_ACTION)
  );
}

/** The single `end` node, or null when the graph has none / more than one. */
function endNode(graph: WorkflowGraph): Node | null {
  const ends = graph.nodes.filter((n) => n.type === "end");
  return ends.length === 1 ? ends[0] : null;
}

/**
 * A graph is a DELIVERY graph (one the gate applies to) when it has a real body:
 * exactly one `start` and one `end` AND at least one non-structural business
 * node between them. A bare start→end skeleton is NOT a delivery graph (nothing
 * to finalize), so we do not force a gate onto an empty template.
 */
export function isDeliveryGraph(graph: WorkflowGraph): boolean {
  const starts = graph.nodes.filter((n) => n.type === "start").length;
  const ends = graph.nodes.filter((n) => n.type === "end").length;
  if (starts !== 1 || ends !== 1) return false;
  return graph.nodes.some((n) => n.type !== "start" && n.type !== "end");
}

/** True when `to` is reachable from `from` by following edges forward. */
function reaches(from: string, to: string, edges: Edge[]): boolean {
  if (from === to) return true;
  const out = new Map<string, string[]>();
  for (const e of edges) {
    const list = out.get(e.from) ?? [];
    list.push(e.to);
    out.set(e.from, list);
  }
  const seen = new Set<string>([from]);
  const stack = [...(out.get(from) ?? [])];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === to) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of out.get(cur) ?? []) stack.push(next);
  }
  return false;
}

/**
 * True when the graph already has the finalize-status gate ON ITS DELIVERY PATH:
 * a finalize-status node exists AND `end` is reachable from it (so the run cannot
 * finish without passing through the gate). The gate need not be the IMMEDIATE
 * predecessor of `end` — the vetted tail run-tests → finalize-status → git-commit
 * → git-push → open-pr → end is fine, because the deterministic commit/push/PR
 * steps after it are themselves vetted library nodes (DESIGN §1.9 / §3.7). What
 * matters is that delivery cannot complete with the gate skipped.
 */
export function hasFinalizeStatusGate(graph: WorkflowGraph): boolean {
  const end = endNode(graph);
  if (!end) return false;
  const gate = graph.nodes.find(isFinalizeStatusNode);
  if (!gate) return false;
  return reaches(gate.id, end.id, graph.edges);
}

/** Result of an injection: the (possibly new) graph + whether it changed. */
export interface FinalizeInjectionResult {
  graph: WorkflowGraph;
  injected: boolean;
  /** The gate node id (existing or newly created). */
  gateNodeId: string | null;
}

/**
 * Ensure a delivery graph has a finalize-status gate immediately before `end`.
 *
 * - Not a delivery graph (no body, or not exactly one start+end) → returned
 *   unchanged (`injected:false`). The gate is only required of real delivery
 *   workflows (DESIGN §6.2b L1).
 * - Already has the gate (gate→end edge) → unchanged.
 * - Otherwise → INSERT a `finalize-status` tool node, RE-ROUTE every edge that
 *   pointed at `end` to point at the gate, and add a single gate→end edge. The
 *   surgery is purely structural and IMMUTABLE (a fresh graph is returned; the
 *   input is never mutated).
 */
export function injectFinalizeStatusGate(
  graph: WorkflowGraph,
): FinalizeInjectionResult {
  if (!isDeliveryGraph(graph)) {
    return { graph, injected: false, gateNodeId: null };
  }
  if (hasFinalizeStatusGate(graph)) {
    const gate = graph.nodes.find(isFinalizeStatusNode);
    return { graph, injected: false, gateNodeId: gate?.id ?? null };
  }

  const end = endNode(graph);
  if (!end) return { graph, injected: false, gateNodeId: null };

  // Build a stable, collision-free id for the injected gate.
  const existingIds = new Set(graph.nodes.map((n) => n.id));
  let gateId = "finalize-status";
  let i = 1;
  while (existingIds.has(gateId)) gateId = `finalize-status-${i++}`;

  const gateNode: Node = {
    id: gateId,
    type: "tool",
    title: "Finalize status",
    nodeDefKey: FINALIZE_STATUS_KEY,
    action: FINALIZE_STATUS_ACTION,
  };

  // Re-route: every edge that fed `end` now feeds the gate; the gate then feeds
  // `end`. Preserve any `when` conditions on the rerouted edges (a branch that
  // ended the run still passes through the gate). Edges NOT pointing at `end`
  // are kept verbatim.
  const reroutedFeeders: Edge[] = [];
  const keptEdges: Edge[] = [];
  for (const e of graph.edges) {
    if (e.to === end.id) {
      reroutedFeeders.push({ ...e, id: `${e.id}__pre-finalize`, to: gateId });
    } else {
      keptEdges.push(e);
    }
  }

  const gateToEnd: Edge = {
    id: `e-${gateId}-${end.id}`,
    from: gateId,
    to: end.id,
  };

  return {
    graph: {
      nodes: [...graph.nodes, gateNode],
      edges: [...keptEdges, ...reroutedFeeders, gateToEnd],
    },
    injected: true,
    gateNodeId: gateId,
  };
}
