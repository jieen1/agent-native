// The ONE in-memory model the editor edits, plus its 1:1 bridge to React Flow.
//
// SINGLE SOURCE OF TRUTH: a `WorkflowGraphModel` is exactly a v2 `WorkflowGraph`
// (nodes + edges from shared/types) PLUS a `positions` map (canvas xy per node).
// The canvas, the inspector, the JSON view, and `save-template` all read/write
// this one object — there is no second representation. React Flow nodes/edges are
// DERIVED from it on render and changes flow back through immutable updaters.
//
// VALIDATION: re-exports the SHARED `validateGraph` from shared/graph-validator so
// the live lint banner calls the EXACT function `save-template` calls. One import,
// one validator (FRONTEND §6.3 / DESIGN §6.3) — never a client-side copy.

import {
  parseGraph,
  type Condition,
  type Edge,
  type Node,
  type NodeType,
  type WorkflowGraph,
} from "../../shared/types";
import { isContainerType } from "./node-meta";

// Local type replacements for @xyflow/react (removed, V3 has no visual editor).
export interface XYPosition {
  x: number;
  y: number;
}

/** Data attached to every canvas node so renderers reach the model node. */
export interface RFNodeData extends Record<string, unknown> {
  node: Node;
  /** Run-mode tint key (NodeRun status). Undefined in edit mode. */
  runStatus?: string;
  /** Run-mode counters (loop iteration / fanout index) for the overlay seam. */
  iteration?: number;
  dynamic?: boolean;
}

export interface RFEdgeData extends Record<string, unknown> {
  when?: Condition;
}

export interface FlowNode {
  id: string;
  type: string;
  position: XYPosition;
  data: RFNodeData;
  selected?: boolean;
  draggable?: boolean;
  connectable?: boolean;
  selectable?: boolean;
  parentId?: string;
  extent?: string;
}
export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  data: RFEdgeData;
  updatable?: boolean;
  selectable?: boolean;
}

// Re-export the SHARED validator. The editor imports `validateGraph` from THIS
// module, which forwards the single implementation in shared/graph-validator —
// the same one `actions/save-template.ts` imports. No second validation pass.
export {
  validateGraph,
  type GraphValidationResult,
} from "../../shared/graph-validator";

/** Canvas coordinate per node id. */
export type PositionMap = Record<string, XYPosition>;

/** The editor's whole editable state: a graph + per-node canvas positions. */
export interface WorkflowGraphModel {
  graph: WorkflowGraph;
  positions: PositionMap;
}

const GRID_X = 240;
const GRID_Y = 140;

/** A deterministic fallback position so a graph with no saved layout still lays
 *  out in a readable grid (left→right by index). */
function fallbackPosition(index: number): XYPosition {
  const col = Math.floor(index / 5);
  const row = index % 5;
  return { x: col * GRID_X, y: row * GRID_Y };
}

/**
 * Build the initial editor model from a parsed/stored graph. Reads any persisted
 * positions from a `__positions` side-channel on the graph object when present
 * (we serialize layout there on save so the canvas reopens where you left it),
 * else falls back to a deterministic grid.
 */
export function modelFromGraph(
  graph: WorkflowGraph,
  storedPositions?: PositionMap,
): WorkflowGraphModel {
  const positions: PositionMap = {};
  graph.nodes.forEach((n, i) => {
    positions[n.id] = storedPositions?.[n.id] ?? fallbackPosition(i);
  });
  return { graph: { nodes: graph.nodes, edges: graph.edges }, positions };
}

/** Parse a raw JSON string/object (the JSON-view textarea, or a stored row) into
 *  a model. Tolerant: bad data is dropped, never throws (parseGraph contract). */
export function modelFromRaw(
  raw: unknown,
  storedPositions?: PositionMap,
): WorkflowGraphModel {
  const obj =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : undefined;
  const embedded =
    obj && typeof obj.__positions === "object"
      ? (obj.__positions as PositionMap)
      : undefined;
  return modelFromGraph(parseGraph(raw), storedPositions ?? embedded);
}

/** The graph JSON that `save-template` stores (positions live in `__positions`
 *  so the canvas layout round-trips, but the validator ignores it). Typed as a
 *  plain `Record` so it satisfies the action mutation arg (`graph: string |
 *  Record<string, unknown>`); shape is still `{ nodes, edges, __positions }`. */
export function graphForSave(
  model: WorkflowGraphModel,
): Record<string, unknown> {
  return {
    nodes: model.graph.nodes,
    edges: model.graph.edges,
    __positions: model.positions,
  };
}

/** Pretty JSON for the JSON-view fallback (canvas + JSON edit the same model). */
export function modelToJson(model: WorkflowGraphModel): string {
  return JSON.stringify(graphForSave(model), null, 2);
}

// ── React Flow derivation (model → RF) ──────────────────────────────────────

/** Container children must come AFTER their parent in the RF node array. */
function orderForRF(nodes: Node[]): Node[] {
  const childIds = new Set<string>();
  for (const n of nodes) {
    if (n.children) for (const c of n.children) childIds.add(c);
  }
  const parents = nodes.filter((n) => !childIds.has(n.id));
  const children = nodes.filter((n) => childIds.has(n.id));
  return [...parents, ...children];
}

/** Map a model node id → its container parent id (for parentNode wiring). */
function parentMap(nodes: Node[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const n of nodes) {
    if (isContainerType(n.type) && n.children) {
      for (const c of n.children) map[c] = n.id;
    }
  }
  return map;
}

export function toFlowNodes(
  model: WorkflowGraphModel,
  opts: { selectedId?: string | null; editable: boolean } = { editable: true },
): FlowNode[] {
  const parents = parentMap(model.graph.nodes);
  const ordered = orderForRF(model.graph.nodes);
  return ordered.map((node) => {
    const parentId = parents[node.id];
    const pos = model.positions[node.id] ?? { x: 0, y: 0 };
    const isContainer = isContainerType(node.type);
    const flowNode: FlowNode = {
      id: node.id,
      type: isContainer ? "container" : "card",
      position: pos,
      data: { node },
      selected: opts.selectedId === node.id,
      draggable: opts.editable,
      connectable: opts.editable,
      selectable: true,
    };
    if (parentId) {
      flowNode.parentId = parentId;
      flowNode.extent = "parent";
    }
    return flowNode;
  });
}

export function toFlowEdges(
  model: WorkflowGraphModel,
  opts: { editable: boolean } = { editable: true },
): FlowEdge[] {
  return model.graph.edges.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    type: "when",
    data: { when: e.when },
    updatable: opts.editable,
    selectable: opts.editable,
  }));
}

// ── immutable model updaters (CRITICAL: never mutate; always return a copy) ───

let idCounter = 0;
/** Stable-enough client-side id for newly-added nodes/edges (server re-keys on
 *  save if needed; uniqueness within the editing session is what matters). */
export function freshId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}`;
}

/** Default field set for a freshly-dropped node of `type`. */
export function makeNode(type: NodeType, idHint?: string): Node {
  const id = idHint ?? freshId(type);
  const node: Node = { id, type, title: defaultTitle(type) };
  if (type === "agent") {
    node.assignee = "local";
    node.prompt = "";
  }
  if (type === "loop") {
    node.maxIterations = 5;
    node.condition = { kind: "agent", prompt: "" };
    node.children = [];
  }
  if (type === "fanout") {
    node.children = [];
  }
  if (type === "parallel") {
    node.children = [];
  }
  return node;
}

function defaultTitle(type: NodeType): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/** A node dropped from the library inherits the def's key + a title. */
export function makeLibraryNode(
  key: string,
  kind: string,
  title: string,
): Node {
  const type: NodeType = kind === "tool" ? "tool" : "agent";
  return {
    id: freshId(key),
    type,
    title: title || key,
    nodeDefKey: key,
  };
}

export function addNode(
  model: WorkflowGraphModel,
  node: Node,
  position: XYPosition,
  parentId?: string,
): WorkflowGraphModel {
  const nodes = [...model.graph.nodes, node];
  const withChild = parentId
    ? nodes.map((n) =>
        n.id === parentId
          ? { ...n, children: [...(n.children ?? []), node.id] }
          : n,
      )
    : nodes;
  return {
    graph: { ...model.graph, nodes: withChild },
    positions: { ...model.positions, [node.id]: position },
  };
}

export function updateNode(
  model: WorkflowGraphModel,
  id: string,
  patch: Partial<Node>,
): WorkflowGraphModel {
  return {
    ...model,
    graph: {
      ...model.graph,
      nodes: model.graph.nodes.map((n) =>
        n.id === id ? ({ ...n, ...patch } as Node) : n,
      ),
    },
  };
}

export function removeNode(
  model: WorkflowGraphModel,
  id: string,
): WorkflowGraphModel {
  const nodes = model.graph.nodes
    .filter((n) => n.id !== id)
    // also detach it from any container's children list
    .map((n) =>
      n.children?.includes(id)
        ? { ...n, children: n.children.filter((c) => c !== id) }
        : n,
    );
  const edges = model.graph.edges.filter((e) => e.from !== id && e.to !== id);
  const positions = { ...model.positions };
  delete positions[id];
  return { graph: { nodes, edges }, positions };
}

export function setPosition(
  model: WorkflowGraphModel,
  id: string,
  position: XYPosition,
): WorkflowGraphModel {
  return { ...model, positions: { ...model.positions, [id]: position } };
}

export function addEdge(
  model: WorkflowGraphModel,
  from: string,
  to: string,
): WorkflowGraphModel {
  if (from === to) return model;
  // de-dupe identical edges
  if (model.graph.edges.some((e) => e.from === from && e.to === to)) {
    return model;
  }
  const edge: Edge = { id: freshId("e"), from, to };
  // branch out-edges default to an (empty) agent condition so the validator
  // surfaces the "missing when" lint as a fixable warning-shaped error, and the
  // inspector can edit it.
  const source = model.graph.nodes.find((n) => n.id === from);
  if (source?.type === "branch") {
    edge.when = { kind: "agent", prompt: "" };
  }
  return {
    ...model,
    graph: { ...model.graph, edges: [...model.graph.edges, edge] },
  };
}

export function updateEdge(
  model: WorkflowGraphModel,
  id: string,
  patch: Partial<Edge>,
): WorkflowGraphModel {
  return {
    ...model,
    graph: {
      ...model.graph,
      edges: model.graph.edges.map((e) =>
        e.id === id ? { ...e, ...patch } : e,
      ),
    },
  };
}

export function removeEdge(
  model: WorkflowGraphModel,
  id: string,
): WorkflowGraphModel {
  return {
    ...model,
    graph: {
      ...model.graph,
      edges: model.graph.edges.filter((e) => e.id !== id),
    },
  };
}

/** A minimal valid starter graph for a brand-new template: start → end. */
export function starterModel(): WorkflowGraphModel {
  const start = makeNode("start", "start");
  const end = makeNode("end", "end");
  return {
    graph: {
      nodes: [start, end],
      edges: [{ id: freshId("e"), from: start.id, to: end.id }],
    },
    positions: {
      [start.id]: { x: 0, y: 0 },
      [end.id]: { x: 0, y: 280 },
    },
  };
}
