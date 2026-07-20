// Orchestration-wide runtime defaults that must be tunable from the Settings
// UI without a code change + redeploy. Persisted as global settings, mirroring
// server/brain/brain-model.ts's pattern.

import { getSetting, putSetting } from "@agent-native/core/settings";

/** Settings key holding spawn.once's default timeout override (seconds). */
export const SPAWN_DEFAULT_TIMEOUT_KEY = "spawn-default-timeout-seconds";

/** Used when no override has ever been saved. */
export const DEFAULT_SPAWN_TIMEOUT_SECONDS = 3600;

export async function getSpawnDefaultTimeoutSeconds(): Promise<number> {
  const stored = await getSetting(SPAWN_DEFAULT_TIMEOUT_KEY);
  const value = stored?.seconds;
  return typeof value === "number" && value > 0
    ? value
    : DEFAULT_SPAWN_TIMEOUT_SECONDS;
}

export async function setSpawnDefaultTimeoutSeconds(
  seconds: number,
): Promise<number> {
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error("seconds must be a positive integer");
  }
  await putSetting(SPAWN_DEFAULT_TIMEOUT_KEY, { seconds });
  return seconds;
}

/**
 * Settings key holding the brain's default periodic drift-check interval
 * (seconds) for threads that leave brain_threads.monitor_interval_sec unset —
 * see server/brain/brain-monitor.ts's defaultMonitorIntervalSec(). Overrides
 * the BRAIN_MONITOR_INTERVAL_SEC env var when set, so the cadence is tunable
 * without a redeploy.
 */
export const BRAIN_MONITOR_DEFAULT_INTERVAL_KEY =
  "brain-monitor-default-interval-seconds";

/** Used when no setting override AND no env var have ever been set. */
export const DEFAULT_BRAIN_MONITOR_INTERVAL_SECONDS = 120;

export async function getBrainMonitorDefaultIntervalSeconds(): Promise<number> {
  const stored = await getSetting(BRAIN_MONITOR_DEFAULT_INTERVAL_KEY);
  const value = stored?.seconds;
  if (typeof value === "number" && value >= 0) return value;
  const raw = process.env.BRAIN_MONITOR_INTERVAL_SEC;
  const envValue = raw != null ? Number(raw) : NaN;
  return Number.isFinite(envValue) && envValue >= 0
    ? envValue
    : DEFAULT_BRAIN_MONITOR_INTERVAL_SECONDS;
}

export async function setBrainMonitorDefaultIntervalSeconds(
  seconds: number,
): Promise<number> {
  if (!Number.isInteger(seconds) || seconds < 0) {
    throw new Error("seconds must be a non-negative integer");
  }
  await putSetting(BRAIN_MONITOR_DEFAULT_INTERVAL_KEY, { seconds });
  return seconds;
}
