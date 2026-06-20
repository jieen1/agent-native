// Concurrency-degree config (DESIGN §6.4). `concurrencyDegree` = how many work
// items the orchestrator runs at once = the worker-pool width. It is a saved
// setting (Settings → Runtime), so it is tuned without code. `maxConcurrentVMs`
// is the SECOND ceiling (§6.4): each running node is one microVM, bounded by the
// KVM host — surfaced alongside concurrencyDegree so the ceiling is never a
// surprise. Both are exposed; neither is hidden.

import { getSetting, putSetting } from "@agent-native/core/settings";
import { DEFAULT_CAPS } from "../engine/types.js";

/** Settings key holding the worker-pool width. */
export const CONCURRENCY_DEGREE_KEY = "orchestrator-concurrency";

/** Default worker-pool width when nothing is saved (DESIGN §6.4: "default e.g. 3"). */
export const DEFAULT_CONCURRENCY_DEGREE = 3;

/** Hard upper bound so a fat-fingered value can't spawn a runaway pool. */
export const MAX_CONCURRENCY_DEGREE = 64;

/**
 * Read the saved concurrency degree (worker-pool width), falling back to the
 * default. A malformed/out-of-range stored value clamps to [1, MAX]. A throwing
 * getSetting degrades to the default rather than failing the whole tick.
 */
export async function getConcurrencyDegree(): Promise<number> {
  let raw: unknown = null;
  try {
    raw = await getSetting(CONCURRENCY_DEGREE_KEY);
  } catch {
    return DEFAULT_CONCURRENCY_DEGREE;
  }
  const value =
    raw && typeof raw === "object"
      ? (raw as { degree?: unknown }).degree
      : raw;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_CONCURRENCY_DEGREE;
  return Math.min(n, MAX_CONCURRENCY_DEGREE);
}

/** Persist a new concurrency degree (clamped to [1, MAX]). Returns the stored value. */
export async function setConcurrencyDegree(degree: number): Promise<number> {
  const clamped = Math.min(Math.max(Math.trunc(degree), 1), MAX_CONCURRENCY_DEGREE);
  await putSetting(CONCURRENCY_DEGREE_KEY, { degree: clamped });
  return clamped;
}

/** The microVM capacity ceiling (DESIGN §6.4/§4.1). P3b reads the engine cap. */
export function getMaxConcurrentVMs(): number {
  return DEFAULT_CAPS.maxConcurrentVMs;
}
