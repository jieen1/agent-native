// The ONE shared v2 graph validator (DESIGN §6.3, FRONTEND "one shared
// validator"). Both the client-side live lint (DAG editor) and the future
// server-side `save-template` action import THIS function — there is no second
// validation pass anywhere. Keeping it in `shared/` is what guarantees a single
// source of truth: a graph the editor accepts is exactly the graph the save
// action accepts.

import type { Condition, Edge, Node, WorkflowGraph } from "./types.js";
import { parseGraph } from "./types.js";

/** Result of validating a graph: errors block save, warnings do not. */
export interface GraphValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Optional hook the server can pass to enforce one-level subworkflow nesting
 * statically: given a `templateRef`, return that template's graph (or null if
 * it cannot be resolved). When omitted, deep-nesting enforcement is left to the
 * scheduler at run time (it expands subworkflows and can detect a second level
 * then) — see the note on the subworkflow rule below.
 */
export type TemplateResolver = (
  templateRef: string,
) => WorkflowGraph | null | undefined;

/** A condition counts as "present" only if it is a recognized shape. */
function hasCondition(cond: Condition | undefined): boolean {
  return cond !== undefined;
}

/**
 * Detect a cycle in the BASE edge graph via Kahn's algorithm (the same
 * technique v1 `topoSortSteps` uses, adapted to nodes+edges). Loops in v2 are
 * expressed only through `loop` NODES, never raw back-edges, so ANY cycle in
 * the base graph is an error. Returns true when the graph is acyclic.
 */
function isAcyclic(nodes: Node[], edges: Edge[]): boolean {
  const ids = new Set(nodes.map((n) => n.id));
  const indegree = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const n of nodes) {
    indegree.set(n.id, 0);
    out.set(n.id, []);
  }
  for (const e of edges) {
    // Ignore edges that dangle off the node set — they cannot form a cycle
    // among real nodes and are reported separately by edge-endpoint checks.
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    out.get(e.from)!.push(e.to);
  }
  const queue = nodes
    .filter((n) => (indegree.get(n.id) ?? 0) === 0)
    .map((n) => n.id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited++;
    for (const next of out.get(id) ?? []) {
      const deg = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }
  return visited === nodes.length;
}

/**
 * Collect every distinct `fanout` node reachable by walking edges BACKWARD from
 * `joinId` (reverse-BFS over the ancestor set). DESIGN §4.1a: a join whose
 * inbound edges trace back to MORE THAN ONE distinct fanout container is
 * illegal, because its expected cardinality cannot be sealed from a single
 * upstream item array.
 */
function upstreamFanouts(
  joinId: string,
  nodesById: Map<string, Node>,
  incoming: Map<string, string[]>,
): Set<string> {
  const found = new Set<string>();
  const seen = new Set<string>([joinId]);
  const stack = [...(incoming.get(joinId) ?? [])];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (nodesById.get(cur)?.type === "fanout") {
      // A fanout seals item identity here; we do not look past it for THIS
      // join's cardinality, but we still record it and keep scanning other
      // inbound branches (a sibling branch may reach a different fanout).
      found.add(cur);
      continue;
    }
    for (const prev of incoming.get(cur) ?? []) stack.push(prev);
  }
  return found;
}

/**
 * Validate a v2 workflow graph. The SINGLE validator both client lint and the
 * save-template action call.
 *
 * ERRORS (block save):
 *  - base edge graph must be acyclic (loops are `loop` nodes, not back-edges)
 *  - exactly one `start` and exactly one `end`
 *  - every `fanout.itemsFrom` references an existing node
 *  - every `loop` has BOTH `condition` and `maxIterations`
 *  - every out-edge of a `branch` carries a `when` condition
 *  - every `subworkflow` has a `templateRef`; with a resolver, reject a
 *    referenced template that itself contains a subworkflow (two-level nesting)
 *  - a `join` reachable (reverse-BFS) from >1 distinct fanout is illegal
 *
 * WARNINGS (do NOT block):
 *  - implicit-barrier lint (§1.3): a `join` with a single inbound edge looks
 *    unintended — a plain pipeline edge would do.
 */
export function validateGraph(
  graph: WorkflowGraph,
  options: { templateResolver?: TemplateResolver } = {},
): GraphValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const { nodes, edges } = graph;
  const nodesById = new Map<string, Node>(nodes.map((n) => [n.id, n]));

  // Duplicate node ids make every downstream lookup ambiguous; surface first.
  if (nodesById.size !== nodes.length) {
    errors.push("Duplicate node ids in graph.");
  }

  // Edge endpoints must reference real nodes (also a precondition for the
  // acyclicity / reverse-BFS passes to be meaningful).
  for (const e of edges) {
    if (!nodesById.has(e.from)) {
      errors.push(`Edge ${e.id} has unknown 'from' node '${e.from}'.`);
    }
    if (!nodesById.has(e.to)) {
      errors.push(`Edge ${e.id} has unknown 'to' node '${e.to}'.`);
    }
  }

  // ── ERROR: acyclic base graph ────────────────────────────────────────────
  if (!isAcyclic(nodes, edges)) {
    errors.push(
      "Base graph has a cycle. Express iteration with a `loop` node, not a back-edge.",
    );
  }

  // ── ERROR: exactly one start and exactly one end ─────────────────────────
  const starts = nodes.filter((n) => n.type === "start");
  const ends = nodes.filter((n) => n.type === "end");
  if (starts.length !== 1) {
    errors.push(
      `Graph must have exactly one 'start' node (found ${starts.length}).`,
    );
  }
  if (ends.length !== 1) {
    errors.push(
      `Graph must have exactly one 'end' node (found ${ends.length}).`,
    );
  }

  // Group out-edges by source for branch + implicit-barrier checks.
  const outBySource = new Map<string, Edge[]>();
  const incoming = new Map<string, string[]>();
  for (const n of nodes) {
    outBySource.set(n.id, []);
    incoming.set(n.id, []);
  }
  for (const e of edges) {
    if (nodesById.has(e.from)) outBySource.get(e.from)!.push(e);
    if (nodesById.has(e.to) && nodesById.has(e.from)) {
      incoming.get(e.to)!.push(e.from);
    }
  }

  for (const node of nodes) {
    // ── ERROR: fanout.itemsFrom must reference an existing node ────────────
    if (node.type === "fanout") {
      if (!node.itemsFrom) {
        errors.push(`Fanout node '${node.id}' is missing 'itemsFrom'.`);
      } else if (!nodesById.has(node.itemsFrom)) {
        errors.push(
          `Fanout node '${node.id}' has 'itemsFrom' '${node.itemsFrom}' which is not an existing node.`,
        );
      }
    }

    // ── ERROR: loop must have BOTH condition and maxIterations ─────────────
    if (node.type === "loop") {
      if (!hasCondition(node.condition)) {
        errors.push(`Loop node '${node.id}' is missing a 'condition'.`);
      }
      if (typeof node.maxIterations !== "number") {
        errors.push(`Loop node '${node.id}' is missing 'maxIterations'.`);
      }
    }

    // ── ERROR: every out-edge of a branch must carry a `when` ──────────────
    if (node.type === "branch") {
      for (const e of outBySource.get(node.id) ?? []) {
        if (!hasCondition(e.when)) {
          errors.push(
            `Branch node '${node.id}' out-edge ${e.id} is missing a 'when' condition.`,
          );
        }
      }
    }

    // ── ERROR: subworkflow must have templateRef (+ one-level nesting) ─────
    if (node.type === "subworkflow") {
      if (!node.templateRef) {
        errors.push(`Subworkflow node '${node.id}' is missing 'templateRef'.`);
      } else if (options.templateResolver) {
        // Static one-level-nesting enforcement is only possible with a
        // resolver. Without one, deep-nesting is left to the scheduler, which
        // expands subworkflows at run time and rejects a second level then.
        const inner = options.templateResolver(node.templateRef);
        if (inner) {
          const innerGraph = "nodes" in inner ? inner : parseGraph(inner);
          if (innerGraph.nodes.some((n) => n.type === "subworkflow")) {
            errors.push(
              `Subworkflow node '${node.id}' references template '${node.templateRef}', ` +
                `which itself contains a subworkflow node (two-level nesting is not allowed).`,
            );
          }
        }
      }
    }

    // ── ERROR / WARNING: join cardinality + implicit-barrier lint ──────────
    if (node.type === "join") {
      const fanouts = upstreamFanouts(node.id, nodesById, incoming);
      if (fanouts.size > 1) {
        errors.push(
          `Join node '${node.id}' is reachable from ${fanouts.size} distinct fanout ` +
            `containers (${[...fanouts].join(", ")}); a join may synchronize at most one fanout.`,
        );
      }
      const inboundCount = (incoming.get(node.id) ?? []).length;
      if (inboundCount <= 1) {
        warnings.push(
          `Join node '${node.id}' has ${inboundCount} inbound edge${inboundCount === 1 ? "" : "s"}; ` +
            `this looks like an unintended barrier — a plain pipeline edge would do (§1.3).`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
