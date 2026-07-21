// LEVEL-1 brain-task concurrency degree. `brainConcurrency` = how many brain
// tasks (each a headless `claude -p` orchestrator brain in its own worktree) run
// at once. It is a saved setting (key-only, global), so it is tuned without code.
// Mirrors server/queue/concurrency.ts in shape but targets the BRAIN, not the v2
// work-item worker pool.

import { getSetting, putSetting } from "@agent-native/core/settings";

/** Settings key holding the brain-task concurrency degree. */
export const BRAIN_CONCURRENCY_KEY = "brain-concurrency";

/** Default brain-task concurrency when nothing is saved. */
export const DEFAULT_BRAIN_CONCURRENCY = 2;

/** Hard upper bound so a fat-fingered value can't spawn a runaway brain pool. */
export const MAX_BRAIN_CONCURRENCY = 32;

/** Lower bound — always at least one brain may run. */
export const MIN_BRAIN_CONCURRENCY = 1;

/**
 * Read the saved brain-task concurrency degree, falling back to the default. A
 * malformed/out-of-range stored value clamps to [MIN, MAX]. A throwing getSetting
 * degrades to the default rather than failing the whole admission tick.
 */
export async function getBrainConcurrency(): Promise<number> {
  let raw: unknown = null;
  try {
    raw = await getSetting(BRAIN_CONCURRENCY_KEY);
  } catch {
    return DEFAULT_BRAIN_CONCURRENCY;
  }
  const value =
    raw && typeof raw === "object" ? (raw as { degree?: unknown }).degree : raw;
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_BRAIN_CONCURRENCY) {
    return DEFAULT_BRAIN_CONCURRENCY;
  }
  return Math.min(n, MAX_BRAIN_CONCURRENCY);
}

/** Persist a new brain-task concurrency degree (clamped to [MIN, MAX]). */
export async function setBrainConcurrency(degree: number): Promise<number> {
  const clamped = Math.min(
    Math.max(Math.trunc(degree), MIN_BRAIN_CONCURRENCY),
    MAX_BRAIN_CONCURRENCY,
  );
  await putSetting(BRAIN_CONCURRENCY_KEY, { degree: clamped });
  return clamped;
}
