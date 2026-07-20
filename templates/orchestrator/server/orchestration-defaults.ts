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
