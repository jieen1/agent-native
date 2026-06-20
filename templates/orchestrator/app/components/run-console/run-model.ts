// Map a live `run-graph` (NodeRuns + template edges) into the SHARED canvas
// model so the run console renders the SAME <WorkflowCanvas> the editor uses,
// in `mode="run"` (FRONTEND §4(a) / §6.3 "one canvas, two modes"). This is the
// run overlay's single source of truth: it is correct-by-construction because it
// reuses the editor's `modelFromGraph` layout + the C2 status color map via the
// canvas's `runStatusByNodeId` seam — we never reinvent the canvas.
//
// A template `nodeId` can have MANY NodeRuns (loop iterations, fanout children,
// retries). The canvas shows the template topology: ONE node per `nodeId`,
// tinted by the most-advanced NodeRun for that node, carrying the highest loop
// iteration and a `dynamic` flag when any of its runs was added at run time.

import type { Node, NodeType, WorkflowGraph } from "../../../shared/types";
import {
  modelFromGraph,
  type WorkflowGraphModel,
} from "@/lib/workflow-graph-model";
import type { RunGraph, RunGraphNode } from "@/hooks/use-runs";

const NODE_TYPES = new Set<string>([
  "start",
  "agent",
  "tool",
  "parallel",
  "fanout",
  "join",
  "branch",
  "loop",
  "subworkflow",
  "human",
  "end",
]);

/** Rank node-run statuses so a node shared by several NodeRuns shows its MOST
 *  advanced/important state (running beats done beats pending). A failure is the
 *  loudest signal, so it wins outright. */
const STATUS_RANK: Record<string, number> = {
  pending: 0,
  ready: 1,
  skipped: 2,
  done: 3,
  "awaiting-approval": 4,
  running: 5,
  failed: 6,
};

function coerceType(type: string): NodeType {
  return (NODE_TYPES.has(type) ? type : "agent") as NodeType;
}

export interface RunCanvasModel {
  model: WorkflowGraphModel;
  /** NodeRun status keyed by template node id → drives the C2 canvas tint. */
  runStatusByNodeId: Record<string, string>;
  /** Highest loop iteration seen per node id (0 outside loops). */
  iterationByNodeId: Record<string, number>;
  /** True when any NodeRun for a node id was dynamically added at run time. */
  dynamicByNodeId: Record<string, boolean>;
}

/**
 * Build the run-overlay canvas model from a `run-graph`. Collapses NodeRuns to
 * one template Node per `nodeId`, derives the per-node status/iteration/dynamic
 * overlay maps, and lays the graph out with the shared `modelFromGraph` (a
 * deterministic grid — run-graph carries no saved canvas positions).
 */
export function runGraphToCanvas(graph: RunGraph): RunCanvasModel {
  const byNodeId = new Map<string, RunGraphNode>();
  const runStatusByNodeId: Record<string, string> = {};
  const iterationByNodeId: Record<string, number> = {};
  const dynamicByNodeId: Record<string, boolean> = {};

  for (const nr of graph.nodeRuns) {
    // Keep the representative NodeRun (first seen) for type/title.
    if (!byNodeId.has(nr.nodeId)) byNodeId.set(nr.nodeId, nr);

    const prev = runStatusByNodeId[nr.nodeId];
    if (
      prev == null ||
      (STATUS_RANK[nr.status] ?? 0) > (STATUS_RANK[prev] ?? 0)
    ) {
      runStatusByNodeId[nr.nodeId] = nr.status;
    }
    iterationByNodeId[nr.nodeId] = Math.max(
      iterationByNodeId[nr.nodeId] ?? 0,
      nr.iteration,
    );
    dynamicByNodeId[nr.nodeId] =
      (dynamicByNodeId[nr.nodeId] ?? false) || nr.dynamic;
  }

  // Edges reference template node ids. A node id that appears on an edge but has
  // no NodeRun yet (not reached) still needs a card, so synthesize one.
  const nodeIds = new Set<string>(byNodeId.keys());
  for (const e of graph.edges) {
    nodeIds.add(e.from);
    nodeIds.add(e.to);
  }

  const nodes: Node[] = [...nodeIds].map((id) => {
    const nr = byNodeId.get(id);
    return {
      id,
      type: coerceType(nr?.type ?? "agent"),
      title: nr?.title || id,
    };
  });

  const wf: WorkflowGraph = {
    nodes,
    edges: graph.edges.map((e) => ({ id: e.id, from: e.from, to: e.to })),
  };

  return {
    model: modelFromGraph(wf),
    runStatusByNodeId,
    iterationByNodeId,
    dynamicByNodeId,
  };
}
