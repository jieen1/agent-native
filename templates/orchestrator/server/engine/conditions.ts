// Pure, deterministic condition evaluation (DESIGN §3.5). No `eval`, no clock,
// no RNG — the engine's only "thinking" is an explicit `agent` condition (not
// used by the P1 echo path; treated as false here and resolved by an executor
// in P2). Branch edge `when` and loop stop predicates flow through here.

import type { Condition } from "../../shared/types.js";
import { readPath } from "./jsonpath.js";

/** State a condition can read: dep outputs + node statuses. */
export interface ConditionContext {
  /** Output value of each in-scope dependency, keyed by node id. */
  deps: Record<string, unknown>;
  /** Status of named nodes, keyed by node id (latest known). */
  status: Record<string, string>;
}

/** Compare two values with a small, total operator set. */
function compare(left: unknown, op: string, right: unknown): boolean {
  switch (op) {
    case "==":
    case "eq":
      return deepEqual(left, right);
    case "!=":
    case "ne":
      return !deepEqual(left, right);
    case ">":
    case "gt":
      return num(left) > num(right);
    case ">=":
    case "gte":
      return num(left) >= num(right);
    case "<":
    case "lt":
      return num(left) < num(right);
    case "<=":
    case "lte":
      return num(left) <= num(right);
    case "truthy":
      return Boolean(left);
    case "falsy":
      return !left;
    case "contains":
      return Array.isArray(left)
        ? left.some((x) => deepEqual(x, right))
        : String(left ?? "").includes(String(right ?? ""));
    default:
      return false;
  }
}

function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  return NaN;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/**
 * Evaluate a Condition against run state. `agent` conditions return false here
 * (they need an executor decision, deferred to P2); jsonpath/status are pure.
 */
export function evalCondition(
  cond: Condition | undefined,
  ctx: ConditionContext,
): boolean {
  if (!cond) return true; // an absent `when` is unconditional (DESIGN §3.3)
  if (cond.kind === "jsonpath") {
    const left = readPath(ctx, cond.path);
    return compare(left, cond.op, cond.value);
  }
  if (cond.kind === "status") {
    return ctx.status[cond.node] === cond.equals;
  }
  // kind === "agent": no model in P1 — treat as not-yet-decided (false).
  return false;
}
