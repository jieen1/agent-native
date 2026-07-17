/**
 * Pure, framework-agnostic column-by-depth layout for a V3 run's DAG.
 *
 * Extracted out of DagVisualizer.tsx so the layout algorithm — the part that
 * actually decides whether two nodes render as parallel siblings (same
 * column) or a serial chain (successive columns) — is unit-testable without
 * React/jsdom. See dag-layout.spec.ts.
 *
 * A node's depth = 1 + max(depth of its dependencies), 0 if it has none.
 * Nodes at the SAME depth with no dependency path between them (e.g.
 * gateStack/gateTests/gateNone fanning out from one upstream node) are true
 * DAG-parallel siblings and are placed in the same column, one row each —
 * never stacked into a single vertical line, which is what made the previous
 * DagVisualizer misread parallel work as a serial chain.
 */

export interface DagLayoutNode {
  id: string;
  type: string;
  /** Declared dependency ids (agent/parallel_over/loop/human_gate nodes all use this). */
  deps?: string[];
}

export interface DagLayoutEdge {
  from: string;
  to: string;
}

export interface LaidOutColumnEntry {
  id: string;
  /** 0-indexed row position within this node's depth column. */
  row: number;
}

export interface DagLayoutResult {
  /** Node ids grouped by depth, outermost array is column index (0 = roots). */
  columns: string[][];
  /** depth (column index) per node id. */
  depthOf: Map<string, number>;
  /** row index within its column per node id — stable vertical position. */
  rowOf: Map<string, number>;
  /** Total columns (max depth + 1), 0 when there are no nodes. */
  columnCount: number;
  /** Max rows in any single column — drives canvas height. */
  maxRows: number;
  /** Node ids that share a column with at least one sibling — i.e. genuinely
   *  run in parallel per the DAG's dependency structure, not merely adjacent
   *  in an arbitrary list order. */
  parallelNodeIds: Set<string>;
  /** The full edge list, unchanged — every edge is a real dependency (a node
   *  runs only after everything it depends on), never a serial-execution-order
   *  artifact of how the nodes happened to be listed. */
  edges: DagLayoutEdge[];
}

/** Builds a dependency set per node id from BOTH node.deps[] and edges[]. */
function buildDepSets(
  nodes: DagLayoutNode[],
  edges: DagLayoutEdge[],
): Map<string, Set<string>> {
  const depSet = new Map<string, Set<string>>();
  for (const n of nodes) depSet.set(n.id, new Set(n.deps ?? []));
  for (const e of edges) {
    if (!depSet.has(e.to)) depSet.set(e.to, new Set());
    depSet.get(e.to)!.add(e.from);
  }
  return depSet;
}

/** Resolves each node's depth (0 = no deps) via memoized recursion; cycle-safe. */
function computeDepths(
  nodeIds: string[],
  depSet: Map<string, Set<string>>,
): Map<string, number> {
  const depths = new Map<string, number>();
  const resolve = (id: string, seen: Set<string>): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0; // cycle guard — the DAG validator rejects real cycles upstream
    seen.add(id);
    const deps = depSet.get(id);
    const depth =
      !deps || deps.size === 0
        ? 0
        : Math.max(...[...deps].map((d) => resolve(d, seen))) + 1;
    depths.set(id, depth);
    return depth;
  };
  for (const id of nodeIds) resolve(id, new Set());
  return depths;
}

export function computeDagLayout(
  nodes: DagLayoutNode[],
  edges: DagLayoutEdge[],
): DagLayoutResult {
  const nodeIds = nodes.map((n) => n.id);
  const depSet = buildDepSets(nodes, edges);
  const depthOf = computeDepths(nodeIds, depSet);

  const columnCount =
    nodeIds.length > 0
      ? Math.max(...nodeIds.map((id) => depthOf.get(id) ?? 0)) + 1
      : 0;
  const columns: string[][] = Array.from({ length: columnCount }, () => []);
  for (const n of nodes) {
    columns[depthOf.get(n.id) ?? 0].push(n.id);
  }

  const rowOf = new Map<string, number>();
  const parallelNodeIds = new Set<string>();
  let maxRows = 0;
  for (const col of columns) {
    maxRows = Math.max(maxRows, col.length);
    col.forEach((id, row) => rowOf.set(id, row));
    if (col.length > 1) for (const id of col) parallelNodeIds.add(id);
  }

  return {
    columns,
    depthOf,
    rowOf,
    columnCount,
    maxRows,
    parallelNodeIds,
    edges,
  };
}
