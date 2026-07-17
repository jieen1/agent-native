// R4a.3 §4.2 point 7 — claude-code WORKER NODE concurrency degree (a
// different dimension from brain-task concurrency in brain-concurrency.ts:
// this caps how many DAG-internal `agent` nodes that resolve to the
// claude-code runtime — via `agent:"claude-code"` or `engine_override`
// pointing at it, see dag-validator.ts's `nodeTargetsClaudeCode` — may spawn
// at once, globally, across ALL runs). Directly modeled on
// brain-concurrency.ts's shape (settings-stored degree, same clamp/default/
// bounds pattern) per the design's own note that this isn't a new mechanism
// to invent from scratch.

import { getSetting, putSetting } from "@agent-native/core/settings";

/** Settings key holding the claude-code worker-node concurrency degree. */
export const CLAUDE_CODE_NODE_CONCURRENCY_KEY = "claude-code-node-concurrency";

/** Default degree when nothing is saved — the design's recommendation (§4.2
 *  point 7: "建议 1") given the CC subscription is a scarce, brain-reserved
 *  resource that review/audit worker nodes borrow from. */
export const DEFAULT_CLAUDE_CODE_NODE_CONCURRENCY = 1;

/** Hard upper bound so a fat-fingered value can't spawn a runaway pool. */
export const MAX_CLAUDE_CODE_NODE_CONCURRENCY = 32;

/** Lower bound — always at least one claude-code node may run. */
export const MIN_CLAUDE_CODE_NODE_CONCURRENCY = 1;

/**
 * Read the saved claude-code-node concurrency degree, falling back to the
 * default. A malformed/out-of-range stored value clamps to [MIN, MAX]. A
 * throwing getSetting degrades to the default rather than failing the
 * reconciler tick that calls this before every claude-code node spawn.
 */
export async function getClaudeCodeNodeConcurrency(): Promise<number> {
  let raw: unknown = null;
  try {
    raw = await getSetting(CLAUDE_CODE_NODE_CONCURRENCY_KEY);
  } catch {
    return DEFAULT_CLAUDE_CODE_NODE_CONCURRENCY;
  }
  const value =
    raw && typeof raw === "object" ? (raw as { degree?: unknown }).degree : raw;
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_CLAUDE_CODE_NODE_CONCURRENCY) {
    return DEFAULT_CLAUDE_CODE_NODE_CONCURRENCY;
  }
  return Math.min(n, MAX_CLAUDE_CODE_NODE_CONCURRENCY);
}

/** Persist a new claude-code-node concurrency degree (clamped to [MIN, MAX]). */
export async function setClaudeCodeNodeConcurrency(
  degree: number,
): Promise<number> {
  const clamped = Math.min(
    Math.max(Math.trunc(degree), MIN_CLAUDE_CODE_NODE_CONCURRENCY),
    MAX_CLAUDE_CODE_NODE_CONCURRENCY,
  );
  await putSetting(CLAUDE_CODE_NODE_CONCURRENCY_KEY, { degree: clamped });
  return clamped;
}
