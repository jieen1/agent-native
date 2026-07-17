/**
 * Client-safe mirror of the V3 DAG node schema (server/engine/dag-validator.ts).
 * Kept as a loose, structural copy — NOT importing the server module directly —
 * so the editor UI never bundles server-only deps (ajv, the expression parser).
 * Field names/shapes here MUST stay in lockstep with dag-validator.ts's
 * V3AgentNode / V3ParallelNode / V3LoopNode / V3HumanGateNode.
 */

export interface V3RetryPolicy {
  max: number;
  on?: string[];
  backoff?: "exponential" | "linear" | "fixed";
  initial_ms?: number;
  max_ms?: number;
}

export interface WorkflowAgentNode {
  type: "agent";
  id: string;
  agent: string;
  prompt: string;
  deps?: string[];
  guard?: string;
  output_schema?: unknown;
  effort?: string;
  model_override?: string;
  workspace?: string;
  max_summary_tokens?: number;
  engine_override?: string;
  retry?: V3RetryPolicy;
  timeout_seconds?: number;
}

export interface WorkflowParallelNode {
  type: "parallel_over";
  id: string;
  deps: string[];
  body: string;
  items_from?: string;
  max_concurrency?: number;
  guard?: string;
}

export interface WorkflowLoopNode {
  type: "loop";
  id: string;
  body: string[];
  until?: string;
  items_from?: string;
  maxIterations?: number;
  max_iterations?: number;
  deps?: string[];
  guard?: string;
}

export interface WorkflowHumanGateNode {
  type: "human_gate";
  id: string;
  prompt: string;
  deps?: string[];
  guard?: string;
  /** Choices a human may pick when resolving this gate (r4 doc §4.5) —
   *  `nodeResolveGate` validates the human's choice against this array when
   *  present (server/engine/dag-validator.ts's V3HumanGateNode mirror). */
  options?: string[];
}

export type WorkflowNode =
  | WorkflowAgentNode
  | WorkflowParallelNode
  | WorkflowLoopNode
  | WorkflowHumanGateNode;

export type WorkflowNodeType = WorkflowNode["type"];

export const NODE_TYPES: WorkflowNodeType[] = [
  "agent",
  "parallel_over",
  "loop",
  "human_gate",
];

export const NODE_TYPE_LABEL: Record<WorkflowNodeType, string> = {
  agent: "智能体",
  parallel_over: "并行",
  loop: "循环",
  human_gate: "人工确认",
};

/** deps[] for any node type, read generically. */
export function nodeDeps(node: WorkflowNode): string[] {
  return (node as { deps?: string[] }).deps ?? [];
}

/** A fresh, minimally-valid node of the given type, with the given id. */
export function blankNode(type: WorkflowNodeType, id: string): WorkflowNode {
  switch (type) {
    case "agent":
      return { type, id, agent: "", prompt: "", deps: [] };
    case "parallel_over":
      return { type, id, deps: [], body: "" };
    case "loop":
      return { type, id, body: [], deps: [] };
    case "human_gate":
      return { type, id, prompt: "", deps: [] };
  }
}

/** Generate a fresh node id that doesn't collide with any existing id. */
export function nextNodeId(
  existing: Iterable<string>,
  type: WorkflowNodeType,
): string {
  const taken = new Set(existing);
  const prefix =
    type === "agent"
      ? "agent"
      : type === "parallel_over"
        ? "parallel"
        : type === "loop"
          ? "loop"
          : "gate";
  let n = 1;
  while (taken.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

/**
 * Rename a node id across the whole DAG: the node itself, plus every
 * structural reference to it (deps[], parallel_over/loop body-by-id).
 * Does NOT rewrite guard/until/items_from expression strings — those are a
 * free-form expression language, and safely rewriting an identifier inside an
 * arbitrary expression requires parsing it, which is out of scope here.
 */
export function renameNodeId(
  nodes: WorkflowNode[],
  oldId: string,
  newId: string,
): WorkflowNode[] {
  if (!newId || oldId === newId) return nodes;
  return nodes.map((n) => {
    const next: WorkflowNode = { ...n, id: n.id === oldId ? newId : n.id };
    if (Array.isArray((next as { deps?: string[] }).deps)) {
      (next as { deps?: string[] }).deps = (
        (next as { deps?: string[] }).deps ?? []
      ).map((d) => (d === oldId ? newId : d));
    }
    if (next.type === "parallel_over") {
      next.body = next.body === oldId ? newId : next.body;
    }
    if (next.type === "loop" && Array.isArray(next.body)) {
      next.body = next.body.map((b) => (b === oldId ? newId : b));
    }
    return next;
  });
}

/** Depth of each node (0 = no deps), used to lay the preview out in columns. */
export function nodeDepths(nodes: WorkflowNode[]): Map<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depths = new Map<string, number>();

  function resolve(id: string, seen: Set<string>): number {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0; // cycle guard — validateDag() surfaces the real error
    seen.add(id);
    const node = byId.get(id);
    const deps = node ? nodeDeps(node) : [];
    const depth =
      deps.length === 0
        ? 0
        : Math.max(...deps.map((d) => resolve(d, seen))) + 1;
    depths.set(id, depth);
    return depth;
  }

  for (const n of nodes) resolve(n.id, new Set());
  return depths;
}

/** Parse per-node error messages out of validateDag()'s flat error list. */
export function groupErrorsByNode(errors: string[]): {
  byNode: Record<string, string[]>;
  global: string[];
} {
  const byNode: Record<string, string[]> = {};
  const global: string[] = [];
  const re = /^Node '([^']+)':\s*(.*)$/;
  for (const err of errors) {
    const m = re.exec(err);
    if (m) {
      const [, nodeId, message] = m;
      (byNode[nodeId] ??= []).push(message);
    } else {
      global.push(err);
    }
  }
  return { byNode, global };
}
