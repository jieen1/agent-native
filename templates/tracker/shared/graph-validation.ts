// Pure, deterministic dependency-graph validation for a scoped set of work
// items (an "epic" = a project, or a sprint) linked by `blocked-by` edges.
// No LLM calls, no I/O — the action layer resolves the node/edge set from the
// DB and calls `validateDependencyGraph` here. This mirrors the umbrella_lint
// graph checks (self-dependency, cycles, chain depth, parallelism, orphans)
// as a first-class, testable algorithm.

export interface GraphNode {
  /** Work item id (used to key adjacency internally). */
  id: string;
  /** Human-readable key shown in messages/paths, e.g. "SDLC-12". */
  itemKey: string;
}

export interface GraphEdge {
  /** The dependent item id (A in "A depends on B" / "A blocked-by B"). */
  fromId: string;
  /** The dependency item id (B in "A depends on B"). */
  toId: string;
}

export interface GraphValidationIssue {
  code:
    | "self-dependency"
    | "cycle"
    | "chain-too-deep"
    | "no-parallelism"
    | "orphan";
  message: string;
  /** itemKeys along the relevant path/chain, when applicable. */
  path?: string[];
}

export interface GraphValidationResult {
  errors: GraphValidationIssue[];
  warnings: GraphValidationIssue[];
  /** Topological order of itemKeys (Kahn's algorithm). Empty when a cycle exists. */
  topoOrder: string[];
}

const CHAIN_DEPTH_WARNING_THRESHOLD = 3;

/**
 * Validate a dependency graph: nodes are work items, edges are directed
 * "A blocked-by B" relations (A depends on B, so B must complete first).
 *
 * Checks:
 * - self-dependency (A blocked-by A) → error, excluded from further analysis
 * - cycles (three-color DFS) → error, with the concrete cycle path
 * - chain depth > 3 nodes → warning, with the deepest chain's path
 * - "no parallelism" (≥3 nodes, fully linear single source/sink) → warning
 * - orphan nodes (≥2 nodes, isolated node with no in/out edges) → warning
 * - topoOrder (Kahn's algorithm, deterministic tie-break by itemKey) — only
 *   populated when the graph (after dropping self-deps) is acyclic.
 */
export function validateDependencyGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
): GraphValidationResult {
  const errors: GraphValidationIssue[] = [];
  const warnings: GraphValidationIssue[] = [];

  const keyOf = new Map<string, string>();
  for (const n of nodes) keyOf.set(n.id, n.itemKey);

  // 1. Self-dependency check — report as error and drop from the adjacency
  // used by every downstream check (cycle/topo/chain/parallelism), since a
  // self-loop would otherwise trivially poison cycle detection.
  const selfDepIds = new Set<string>();
  for (const e of edges) {
    if (e.fromId === e.toId) {
      selfDepIds.add(e.fromId);
      errors.push({
        code: "self-dependency",
        message: `${keyOf.get(e.fromId) ?? e.fromId} 依赖自身`,
        path: [keyOf.get(e.fromId) ?? e.fromId],
      });
    }
  }

  const realEdges = edges.filter(
    (e) => e.fromId !== e.toId && keyOf.has(e.fromId) && keyOf.has(e.toId),
  );

  // adjacency: fromId -> [toId, ...]  (A -> B means "A depends on B")
  const adj = new Map<string, string[]>();
  // indegree(X) = number of nodes that depend ON X (edges pointing into X);
  // outdegree(X) = number of things X itself depends on (edges out of X).
  const indegree = new Map<string, number>();
  const outdegree = new Map<string, number>();

  for (const n of nodes) {
    adj.set(n.id, []);
    indegree.set(n.id, 0);
    outdegree.set(n.id, 0);
  }
  for (const e of realEdges) {
    adj.get(e.fromId)!.push(e.toId);
    outdegree.set(e.fromId, (outdegree.get(e.fromId) ?? 0) + 1);
    indegree.set(e.toId, (indegree.get(e.toId) ?? 0) + 1);
  }

  // 2. Cycle detection — three-color DFS (white/gray/black), deterministic
  // node visit order by itemKey for stable, reproducible cycle paths.
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n.id, WHITE);

  const orderedNodeIds = [...nodes]
    .sort((a, b) => a.itemKey.localeCompare(b.itemKey))
    .map((n) => n.id);

  let cyclePath: string[] | null = null;
  const stack: string[] = [];

  function dfs(u: string): boolean {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of adj.get(u) ?? []) {
      if (color.get(v) === GRAY) {
        // Found a back-edge — extract the cycle from the stack.
        const idx = stack.indexOf(v);
        const cycleIds = stack.slice(idx).concat(v);
        cyclePath = cycleIds.map((id) => keyOf.get(id) ?? id);
        return true;
      }
      if (color.get(v) === WHITE) {
        if (dfs(v)) return true;
      }
    }
    stack.pop();
    color.set(u, BLACK);
    return false;
  }

  let hasCycle = false;
  for (const id of orderedNodeIds) {
    if (color.get(id) === WHITE) {
      if (dfs(id)) {
        hasCycle = true;
        break;
      }
    }
  }

  if (hasCycle && cyclePath) {
    const path: string[] = cyclePath;
    errors.push({
      code: "cycle",
      message: `发现依赖环: ${path.join(" → ")}`,
      path,
    });
  }

  let topoOrder: string[] = [];

  if (!hasCycle) {
    // 3. Kahn's algorithm producing a valid EXECUTION order: a node is
    // "ready" once every dependency it has (adj[u], the things it is
    // blocked-by) is already in the order. So we start from outdegree-0
    // nodes (no dependencies of their own) and, once a node is placed,
    // decrement the remaining-dependency count of the nodes that depend ON
    // it (via the reverse adjacency), pushing them once that count hits 0.
    // Deterministic (itemKey-sorted) tie-break at each step.
    const revAdj = new Map<string, string[]>();
    for (const n of nodes) revAdj.set(n.id, []);
    for (const e of realEdges) revAdj.get(e.toId)!.push(e.fromId);

    const outdegreeCopy = new Map(outdegree);
    const available = nodes
      .filter((n) => (outdegreeCopy.get(n.id) ?? 0) === 0)
      .sort((a, b) => a.itemKey.localeCompare(b.itemKey))
      .map((n) => n.id);
    const queue = [...available];
    const order: string[] = [];

    while (queue.length > 0) {
      // Pop the itemKey-smallest available id to keep ordering deterministic.
      queue.sort((a, b) =>
        (keyOf.get(a) ?? a).localeCompare(keyOf.get(b) ?? b),
      );
      const u = queue.shift()!;
      order.push(u);
      for (const v of revAdj.get(u) ?? []) {
        outdegreeCopy.set(v, (outdegreeCopy.get(v) ?? 0) - 1);
        if (outdegreeCopy.get(v) === 0) queue.push(v);
      }
    }

    topoOrder = order.map((id) => keyOf.get(id) ?? id);

    // 4. Chain depth (node-count) via DP over the DAG in reverse-topo order:
    // longestChain(u) = 1 + max(longestChain(v) for v in adj[u]), base case 1.
    const memo = new Map<string, number>();
    const bestNext = new Map<string, string | null>();

    function longestChain(u: string): number {
      if (memo.has(u)) return memo.get(u)!;
      let best = 1;
      let bestChild: string | null = null;
      for (const v of adj.get(u) ?? []) {
        const childLen = 1 + longestChain(v);
        if (childLen > best) {
          best = childLen;
          bestChild = v;
        }
      }
      memo.set(u, best);
      bestNext.set(u, bestChild);
      return best;
    }

    let deepestNode: string | null = null;
    let deepestLen = 0;
    for (const n of nodes) {
      const len = longestChain(n.id);
      if (len > deepestLen) {
        deepestLen = len;
        deepestNode = n.id;
      }
    }

    if (deepestNode && deepestLen > CHAIN_DEPTH_WARNING_THRESHOLD) {
      const chain: string[] = [];
      let cur: string | null = deepestNode;
      while (cur) {
        chain.push(keyOf.get(cur) ?? cur);
        cur = bestNext.get(cur) ?? null;
      }
      warnings.push({
        code: "chain-too-deep",
        message: `依赖链深度为 ${deepestLen}(>3): ${chain.join(" → ")}`,
        path: chain,
      });
    }

    // 5. No-parallelism: ≥3 nodes, every node has in/out-degree ≤1, and there
    // is exactly one source (indegree 0) and one sink (outdegree 0) — i.e.
    // the whole graph is one single linear chain with no branching.
    if (nodes.length >= 3) {
      const allDegreeAtMostOne = nodes.every(
        (n) =>
          (indegree.get(n.id) ?? 0) <= 1 && (outdegree.get(n.id) ?? 0) <= 1,
      );
      const sources = nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0);
      const sinks = nodes.filter((n) => (outdegree.get(n.id) ?? 0) === 0);
      const hasAnyEdge = realEdges.length > 0;
      if (
        allDegreeAtMostOne &&
        hasAnyEdge &&
        sources.length === 1 &&
        sinks.length === 1
      ) {
        warnings.push({
          code: "no-parallelism",
          message: "依赖图完全线性,无并行度",
          path: topoOrder,
        });
      }
    }
  }

  // 6. Orphan check (≥2 nodes): nodes with neither incoming nor outgoing
  // real edges. Runs regardless of cycle status.
  if (nodes.length >= 2) {
    const orphans = nodes.filter(
      (n) =>
        (indegree.get(n.id) ?? 0) === 0 && (outdegree.get(n.id) ?? 0) === 0,
    );
    if (orphans.length > 0) {
      const orphanKeys = orphans.map((n) => n.itemKey);
      warnings.push({
        code: "orphan",
        message: `存在孤儿节点(无依赖也无被依赖): ${orphanKeys.join(", ")}`,
        path: orphanKeys,
      });
    }
  }

  return { errors, warnings, topoOrder };
}
