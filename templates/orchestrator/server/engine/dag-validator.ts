import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { FormatName } from "ajv-formats";

import { validateExpressionSyntax } from "./expression-parser.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface V3Dag {
  nodes: V3Node[];
}

/** Retry policy for agent nodes (§12). */
export interface V3RetryPolicy {
  max: number;
  on?: string[];
  backoff?: "exponential" | "linear" | "fixed";
  initial_ms?: number;
  max_ms?: number;
}

export interface V3AgentNode {
  type: "agent";
  id: string;
  agent: string;
  prompt: string;
  deps?: string[];
  guard?: string;
  output_schema?: unknown;
  effort?: string;
  model_override?: string;
  // G40: additional optional fields per §4.1
  workspace?: string;
  max_summary_tokens?: number;
  engine_override?: string;
  retry?: V3RetryPolicy;
  timeout_seconds?: number;
}

export interface V3ParallelNode {
  type: "parallel_over";
  id: string;
  deps: string[];
  /** G41: body may be a node-id string OR an inline agent node definition. */
  body: string | Omit<V3AgentNode, "id" | "deps">;
  /** G41: optional expression yielding the items array (evaluated at runtime). */
  items_from?: string;
  /** G41: optional concurrency cap. */
  max_concurrency?: number;
  guard?: string;
}

export interface V3LoopNode {
  type: "loop";
  id: string;
  /** G42: body may be a single node-id string OR an ordered array of node-id strings. */
  body: string | string[];
  until?: string;
  items_from?: string;
  /** G42: accept both maxIterations (legacy) and max_iterations (design alias). */
  maxIterations?: number;
  max_iterations?: number;
  deps?: string[];
  guard?: string;
}

export interface V3HumanGateNode {
  type: "human_gate";
  id: string;
  prompt: string;
  deps?: string[];
  guard?: string;
}

export type V3Node =
  | V3AgentNode
  | V3ParallelNode
  | V3LoopNode
  | V3HumanGateNode;

const VALID_TYPES = new Set(["agent", "parallel_over", "loop", "human_gate"]);

// ── R4a.3 §4.2 point 7 — claude-code engine recognition ─────────────────────
//
// True for either the literal agent-def name "claude-code" or an
// `acp:claude*` engine string. Historically only checked against
// `engine_override` (the hard mechanism-level ban below, unchanged): a DAG
// worker node may never explicitly override its engine to reach the CC
// subscription runtime directly. Exported so callers OUTSIDE this file (the
// claude-code concurrency admission gate, server/queue/claude-code-admit.ts)
// can recognize the SAME "this node resolves to the claude-code runtime"
// condition via the `agent` field too — closing the real gap the design
// identified: `agent:"claude-code"` was never recognized by ANY mechanism
// before this, not even for resource-protection purposes.
//
// IMPORTANT — this does NOT extend the hard validation-error ban to the
// `agent` field. `agent:"claude-code"` is a first-party, sanctioned worker
// (framework agent-def `.claude/agents/claude-code.md`, used for review/audit
// nodes by all 9 seed templates and by production brain-authored DAGs like
// `sdlc-issue-pipeline` v4) — banning it here would break those. The
// resource-protection concern (unlimited concurrent claude-code spawns) is
// closed by the concurrency gate, not by rejecting the DAG at save/validate
// time.
export function isClaudeCodeEngineRef(ref: string | null | undefined): boolean {
  if (!ref) return false;
  const v = ref.trim();
  return v === "claude-code" || v.toLowerCase().startsWith("acp:claude");
}

/** True when this agent node resolves to the claude-code runtime via EITHER
 *  `engine_override` (blocked outright by validateDag, see below) OR `agent`
 *  (sanctioned — see doc comment above). Used by the concurrency gate to
 *  recognize both paths consistently. Accepts a loosely-typed subset (both
 *  fields optional) rather than `Pick<V3AgentNode, ...>` so callers working
 *  from an untyped/parsed dag node (e.g. the reconciler's `V3NodeDag`, or a
 *  JSON-parsed run.dag) can pass partial data without a cast fight. */
export function nodeTargetsClaudeCode(node: {
  agent?: string | null;
  engine_override?: string | null;
}): boolean {
  return (
    isClaudeCodeEngineRef(node.engine_override) ||
    isClaudeCodeEngineRef(node.agent)
  );
}

// ── Public API ─────────────────────────────────────────────────────────────

export function validateDag(dag: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  // Rule 1: Parse JSON string input
  let parsed: unknown = dag;
  if (typeof dag === "string") {
    try {
      parsed = JSON.parse(dag);
    } catch (err: any) {
      return {
        ok: false,
        errors: [`Failed to parse JSON: ${err.message ?? String(err)}`],
      };
    }
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as any).nodes)
  ) {
    return { ok: false, errors: ["dag must be an object with a nodes array"] };
  }

  const nodes: V3Node[] = (parsed as V3Dag).nodes;

  // Rule 2: non-empty
  if (nodes.length === 0) {
    return { ok: false, errors: ["nodes must be a non-empty array"] };
  }

  // --- Rule 2 & 3: shape + type ---
  const idSet = new Set<string>();
  const existingIds = new Set<string>();

  for (const node of nodes) {
    if (!node || typeof node !== "object") {
      errors.push("Node: must be a non-null object with type and id");
      continue;
    }
    if (typeof node.id !== "string" || typeof node.type !== "string") {
      errors.push(
        `Node '${String(node.id ?? "?")}': must have string type and id`,
      );
      continue;
    }

    const { id, type } = node;

    if (idSet.has(id)) {
      // Rule 4: duplicate
      errors.push(`Node '${id}': duplicate id`);
    }
    idSet.add(id);
    existingIds.add(id);

    if (!VALID_TYPES.has(type)) {
      errors.push(`Node '${id}': unknown type '${type}'`);
    }
  }

  // --- Rule 5: deps point to existing ids ---
  for (const node of nodes) {
    if (!node || typeof node !== "object" || typeof node.id !== "string")
      continue;
    const deps = "deps" in node ? (node as any).deps : undefined;
    if (Array.isArray(deps)) {
      for (const dep of deps) {
        if (!existingIds.has(dep)) {
          errors.push(`Node '${node.id}': dep '${dep}' not found`);
        }
      }
    }
  }

  // --- Rule 6: cycle detection (DFS) ---
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node || typeof node !== "object" || typeof node.id !== "string")
      continue;
    const nDeps = "deps" in node ? (node as any).deps : undefined;
    adjacency.set(node.id, Array.isArray(nDeps) ? nDeps : []);
  }
  const cycleNode = detectCycle(adjacency);
  if (cycleNode) {
    errors.push(`Cycle detected involving '${cycleNode}'`);
  }

  // --- Ajv for schema validation ---
  const ajv = new Ajv({ strict: false });
  const allFormats: FormatName[] = [
    "date",
    "time",
    "date-time",
    "duration",
    "uri",
    "uri-reference",
    "uri-template",
    "url",
    "email",
    "hostname",
    "ipv4",
    "ipv6",
    "regex",
    "uuid",
    "json-pointer",
    "json-pointer-uri-fragment",
    "relative-json-pointer",
    "byte",
    "int32",
    "int64",
    "float",
    "double",
  ];
  addFormats(ajv, allFormats);

  // --- Node-specific rules ---
  for (const node of nodes) {
    if (!node || typeof node !== "object" || typeof node.id !== "string")
      continue;
    const { id, type } = node;

    // ── Shared: guard validation (§4 — applies to ALL node types) ──
    const sharedGuard = (node as any).guard;
    if (sharedGuard != null) {
      if (typeof sharedGuard !== "string") {
        errors.push(`Node '${id}': guard must be a string expression`);
      } else {
        const gResult = validateExpressionSyntax(sharedGuard);
        if (!gResult.ok) {
          errors.push(
            `Node '${id}': guard expression: ${gResult.error ?? "syntax error"}`,
          );
        }
      }
    }

    if (type === "agent") {
      const agent = node as V3AgentNode;

      if (
        !agent.agent ||
        typeof agent.agent !== "string" ||
        !agent.agent.trim()
      ) {
        errors.push(`Node '${id}': agent must be a non-empty string`);
      }
      if (
        !agent.prompt ||
        typeof agent.prompt !== "string" ||
        !agent.prompt.trim()
      ) {
        errors.push(`Node '${id}': prompt must be a non-empty string`);
      }
      if (agent.output_schema != null) {
        try {
          if (
            typeof agent.output_schema !== "object" ||
            Array.isArray(agent.output_schema)
          ) {
            errors.push(
              `Node '${id}': output_schema must be a JSON Schema object`,
            );
          } else {
            ajv.compile(agent.output_schema as object);
          }
        } catch (err: any) {
          errors.push(
            `Node '${id}': invalid output_schema: ${err.message ?? String(err)}`,
          );
        }
      }
      // G40: validate optional numeric/object fields
      if (
        agent.max_summary_tokens != null &&
        typeof agent.max_summary_tokens !== "number"
      ) {
        errors.push(`Node '${id}': max_summary_tokens must be a number`);
      }
      if (
        agent.timeout_seconds != null &&
        typeof agent.timeout_seconds !== "number"
      ) {
        errors.push(`Node '${id}': timeout_seconds must be a number`);
      }
      if (agent.workspace != null && typeof agent.workspace !== "string") {
        errors.push(`Node '${id}': workspace must be a string`);
      }
      if (
        agent.engine_override != null &&
        typeof agent.engine_override !== "string"
      ) {
        errors.push(`Node '${id}': engine_override must be a string`);
      }
      if (
        typeof agent.engine_override === "string" &&
        isClaudeCodeEngineRef(agent.engine_override)
      ) {
        errors.push(
          `Node '${id}': engine_override 'claude-code' is not allowed on DAG worker nodes — ` +
            "CC subscription is reserved for the brain only. " +
            "Use ai-sdk:anthropic, ai-sdk:openai, or a vllm/remote-api runtime_config instead.",
        );
      }
      if (agent.retry != null) {
        if (typeof agent.retry !== "object" || Array.isArray(agent.retry)) {
          errors.push(`Node '${id}': retry must be an object`);
        } else if (typeof (agent.retry as V3RetryPolicy).max !== "number") {
          errors.push(`Node '${id}': retry.max must be a number`);
        }
      }
    }

    if (type === "parallel_over") {
      const pnode = node as V3ParallelNode;
      if (!Array.isArray(pnode.deps) || pnode.deps.length === 0) {
        errors.push(`Node '${id}': deps must be a non-empty array`);
      }
      // G41: body may be a node-id string OR an inline agent node object
      if (pnode.body == null) {
        errors.push(`Node '${id}': body is required`);
      } else if (typeof pnode.body === "string") {
        if (!existingIds.has(pnode.body)) {
          errors.push(`Node '${id}': body '${pnode.body}' not found`);
        }
      } else if (typeof pnode.body === "object" && !Array.isArray(pnode.body)) {
        const inlineBody = pnode.body as Omit<V3AgentNode, "id" | "deps">;
        if (inlineBody.type !== "agent") {
          errors.push(`Node '${id}': inline body type must be 'agent'`);
        }
        if (
          !inlineBody.agent ||
          typeof inlineBody.agent !== "string" ||
          !inlineBody.agent.trim()
        ) {
          errors.push(
            `Node '${id}': inline body agent must be a non-empty string`,
          );
        }
        if (
          !inlineBody.prompt ||
          typeof inlineBody.prompt !== "string" ||
          !inlineBody.prompt.trim()
        ) {
          errors.push(
            `Node '${id}': inline body prompt must be a non-empty string`,
          );
        }
      } else {
        errors.push(
          `Node '${id}': body must be a node-id string or an inline agent node object`,
        );
      }
      // G41: validate max_concurrency
      if (
        pnode.max_concurrency != null &&
        (typeof pnode.max_concurrency !== "number" || pnode.max_concurrency < 1)
      ) {
        errors.push(`Node '${id}': max_concurrency must be a positive number`);
      }
      // G41: validate items_from as expression (kept as string per design)
      if (pnode.items_from != null) {
        if (typeof pnode.items_from !== "string") {
          errors.push(`Node '${id}': items_from must be a string expression`);
        } else {
          const iResult = validateExpressionSyntax(pnode.items_from);
          if (!iResult.ok) {
            errors.push(
              `Node '${id}': items_from expression: ${iResult.error ?? "syntax error"}`,
            );
          }
        }
      }
    }

    if (type === "loop") {
      const lnode = node as V3LoopNode;
      // G42: body may be a single node-id string OR an ordered array of node-id strings
      if (lnode.body == null) {
        errors.push(`Node '${id}': body is required`);
      } else if (typeof lnode.body === "string") {
        if (!existingIds.has(lnode.body)) {
          errors.push(`Node '${id}': body '${lnode.body}' not found`);
        }
      } else if (Array.isArray(lnode.body)) {
        if (lnode.body.length === 0) {
          errors.push(`Node '${id}': body array must not be empty`);
        }
        for (const bodyId of lnode.body) {
          if (!existingIds.has(bodyId)) {
            errors.push(`Node '${id}': body node '${bodyId}' not found`);
          }
        }
      } else {
        errors.push(
          `Node '${id}': body must be a node-id string or an array of node-id strings`,
        );
      }
      if (lnode.until) {
        const uResult = validateExpressionSyntax(lnode.until);
        if (!uResult.ok) {
          errors.push(
            `Node '${id}': until expression: ${uResult.error ?? "syntax error"}`,
          );
        }
      }
      if (lnode.items_from) {
        const iResult = validateExpressionSyntax(lnode.items_from);
        if (!iResult.ok) {
          errors.push(
            `Node '${id}': items_from expression: ${iResult.error ?? "syntax error"}`,
          );
        }
      }
      // G42: validate both maxIterations and max_iterations (aliases); if both set they must agree
      const mi1 = lnode.maxIterations;
      const mi2 = lnode.max_iterations;
      if (mi1 != null && typeof mi1 !== "number") {
        errors.push(`Node '${id}': maxIterations must be a number`);
      }
      if (mi2 != null && typeof mi2 !== "number") {
        errors.push(`Node '${id}': max_iterations must be a number`);
      }
      if (mi1 != null && mi2 != null && mi1 !== mi2) {
        errors.push(
          `Node '${id}': maxIterations and max_iterations are aliases — they must not conflict`,
        );
      }
    }

    if (type === "human_gate") {
      const hnode = node as V3HumanGateNode;
      if (
        !hnode.prompt ||
        typeof hnode.prompt !== "string" ||
        !hnode.prompt.trim()
      ) {
        errors.push(`Node '${id}': prompt must be a non-empty string`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// ── Cycle detection (iterative DFS) ────────────────────────────────────────

export function detectCycle(adjacency: Map<string, string[]>): string | null {
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();

  for (const node of adjacency.keys()) color.set(node, WHITE);

  for (const start of adjacency.keys()) {
    if (color.get(start)! !== WHITE) continue;

    // Stack entries: [node, neighborIndex]
    const stack: Array<[string, number]> = [[start, 0]];
    color.set(start, GRAY);

    while (stack.length) {
      const top = stack[stack.length - 1];
      const current = top[0];
      const neighbors = adjacency.get(current)!;
      let ni = top[1];

      let found = false;
      while (ni < neighbors.length) {
        const neighbor = neighbors[ni];
        ni++;
        top[1] = ni; // save progress
        const c = color.get(neighbor);
        if (c === GRAY) {
          return neighbor;
        }
        if (c === WHITE && adjacency.has(neighbor)) {
          color.set(neighbor, GRAY);
          stack.push([neighbor, 0]);
          found = true;
          break;
        }
      }

      if (!found) {
        color.set(current, BLACK);
        stack.pop();
      }
    }
  }

  return null;
}
