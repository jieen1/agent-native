import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { FormatName } from "ajv-formats";
import { validateExpressionSyntax } from "./expression-parser.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface V3Dag {
  nodes: V3Node[];
}

export interface V3AgentNode {
  type: "agent";
  id: string;
  agent: string;
  prompt: string;
  deps?: string[];
  output_schema?: unknown;
  effort?: string;
  guard?: string;
  model_override?: string;
}

export interface V3ParallelNode {
  type: "parallel_over";
  id: string;
  deps: string[];
  body: string;
}

export interface V3LoopNode {
  type: "loop";
  id: string;
  body: string;
  until?: string;
  items_from?: string;
  maxIterations?: number;
}

export interface V3HumanGateNode {
  type: "human_gate";
  id: string;
  prompt: string;
  deps?: string[];
}

export type V3Node = V3AgentNode | V3ParallelNode | V3LoopNode | V3HumanGateNode;

const VALID_TYPES = new Set(["agent", "parallel_over", "loop", "human_gate"]);

// ── Public API ─────────────────────────────────────────────────────────────

export function validateDag(dag: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  // Rule 1: Parse JSON string input
  let parsed: unknown = dag;
  if (typeof dag === "string") {
    try {
      parsed = JSON.parse(dag);
    } catch (err: any) {
      return { ok: false, errors: [`Failed to parse JSON: ${err.message ?? String(err)}`] };
    }
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as any).nodes)) {
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
      errors.push(`Node '${String(node.id ?? "?")}': must have string type and id`);
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
    if (!node || typeof node !== "object" || typeof node.id !== "string") continue;
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
    if (!node || typeof node !== "object" || typeof node.id !== "string") continue;
    const nDeps = "deps" in node ? (node as any).deps : undefined;
    adjacency.set(node.id, Array.isArray(nDeps) ? nDeps : []);
  }
  const cycleNode = detectCycle(adjacency);
  if (cycleNode) {
    errors.push(`Cycle detected involving '${cycleNode}'`);
  }

  // --- Ajv for schema validation ---
  const ajv = new Ajv({ strict: false });
  const allFormats: FormatName[] = ["date", "time", "date-time", "duration", "uri", "uri-reference", "uri-template", "url", "email", "hostname", "ipv4", "ipv6", "regex", "uuid", "json-pointer", "json-pointer-uri-fragment", "relative-json-pointer", "byte", "int32", "int64", "float", "double"];
  addFormats(ajv, allFormats);

  // --- Node-specific rules ---
  for (const node of nodes) {
    if (!node || typeof node !== "object" || typeof node.id !== "string") continue;
    const { id, type } = node;

    if (type === "agent") {
      const agent = node as V3AgentNode;

      if (!agent.agent || typeof agent.agent !== "string" || !agent.agent.trim()) {
        errors.push(`Node '${id}': agent must be a non-empty string`);
      }
      if (!agent.prompt || typeof agent.prompt !== "string" || !agent.prompt.trim()) {
        errors.push(`Node '${id}': prompt must be a non-empty string`);
      }
      if (agent.guard) {
        const gResult = validateExpressionSyntax(agent.guard);
        if (!gResult.ok) {
          errors.push(`Node '${id}': guard expression: ${gResult.error ?? "syntax error"}`);
        }
      }
      if (agent.output_schema != null) {
        try {
          if (typeof agent.output_schema !== "object" || Array.isArray(agent.output_schema)) {
            errors.push(`Node '${id}': output_schema must be a JSON Schema object`);
          } else {
            ajv.compile(agent.output_schema as object);
          }
        } catch (err: any) {
          errors.push(`Node '${id}': invalid output_schema: ${err.message ?? String(err)}`);
        }
      }
    }

    if (type === "parallel_over") {
      const pnode = node as V3ParallelNode;
      if (!Array.isArray(pnode.deps) || pnode.deps.length === 0) {
        errors.push(`Node '${id}': deps must be a non-empty array`);
      }
      if (!pnode.body || typeof pnode.body !== "string" || !existingIds.has(pnode.body)) {
        errors.push(`Node '${id}': body '${pnode.body ?? ""}' not found`);
      }
    }

    if (type === "loop") {
      const lnode = node as V3LoopNode;
      if (!lnode.body || typeof lnode.body !== "string" || !existingIds.has(lnode.body)) {
        errors.push(`Node '${id}': body '${lnode.body ?? ""}' not found`);
      }
      if (lnode.until) {
        const uResult = validateExpressionSyntax(lnode.until);
        if (!uResult.ok) {
          errors.push(`Node '${id}': until expression: ${uResult.error ?? "syntax error"}`);
        }
      }
      if (lnode.items_from) {
        const iResult = validateExpressionSyntax(lnode.items_from);
        if (!iResult.ok) {
          errors.push(`Node '${id}': items_from expression: ${iResult.error ?? "syntax error"}`);
        }
      }
    }

    if (type === "human_gate") {
      const hnode = node as V3HumanGateNode;
      if (!hnode.prompt || typeof hnode.prompt !== "string" || !hnode.prompt.trim()) {
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
    const stack: Array<[string, number]> = [
      [start, 0],
    ];
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
