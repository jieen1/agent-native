// Real, persisted scheduler pause/resume + health-gate rejection log for the
// execution queue (03-tracker.md §8). Backed by the framework's generic
// settings store (@agent-native/core/settings), NOT a useState toggle — state
// survives reload/restart. Keys are tracker-prefixed because tracker and
// orchestrator share one Postgres `settings` table in production (see
// schema.ts's execQueue docblock / orchestrator-client.ts) — an unprefixed key
// like "scheduler" would risk colliding with an orchestrator setting.
import { getSetting, putSetting } from "@agent-native/core/settings";

export const SCHEDULER_SETTING_KEY = "tracker-queue-scheduler";
export const HEALTH_LOG_SETTING_KEY = "tracker-queue-health-log";

export interface SchedulerState {
  paused: boolean;
  pausedAt: string | null;
  pausedBy: string | null;
  resumedAt: string | null;
  resumedBy: string | null;
}

const DEFAULT_STATE: SchedulerState = {
  paused: false,
  pausedAt: null,
  pausedBy: null,
  resumedAt: null,
  resumedBy: null,
};

/** Read the persisted scheduler state. A throwing/missing setting degrades to
 *  "not paused" (fail-open) — mirrors orchestrator's getBrainConcurrency
 *  pattern (server/queue/brain-concurrency.ts) so a settings-store hiccup
 *  never wedges every dispatch in the app. */
export async function getSchedulerState(): Promise<SchedulerState> {
  try {
    const raw = (await getSetting(
      SCHEDULER_SETTING_KEY,
    )) as Partial<SchedulerState> | null;
    if (!raw) return { ...DEFAULT_STATE };
    return {
      paused: !!raw.paused,
      pausedAt: raw.pausedAt ?? null,
      pausedBy: raw.pausedBy ?? null,
      resumedAt: raw.resumedAt ?? null,
      resumedBy: raw.resumedBy ?? null,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export interface HealthRejection {
  reason: string;
  at: string;
  workItemId?: string;
}

/** Best-effort — logging a rejection must never mask the real error the
 *  caller is about to throw. */
export async function recordHealthRejection(
  entry: Omit<HealthRejection, "at">,
): Promise<void> {
  try {
    const record: HealthRejection = { ...entry, at: new Date().toISOString() };
    await putSetting(
      HEALTH_LOG_SETTING_KEY,
      record as unknown as Record<string, unknown>,
    );
  } catch {
    // Non-fatal — the caller's real rejection error still propagates.
  }
}

export async function getLastHealthRejection(): Promise<HealthRejection | null> {
  try {
    const raw = (await getSetting(
      HEALTH_LOG_SETTING_KEY,
    )) as HealthRejection | null;
    return raw ?? null;
  } catch {
    return null;
  }
}

export class SchedulerPausedError extends Error {
  code = "scheduler-paused" as const;
  constructor() {
    super("调度器已暂停，暂不可派发。请先在队列页恢复调度器。");
    this.name = "SchedulerPausedError";
  }
}

/**
 * Throws SchedulerPausedError (and logs the rejection) when the scheduler is
 * paused. Call BEFORE any orchestrator MCP call in a dispatch path, so a
 * paused scheduler has a REAL effect (no brain-send round trip) rather than
 * only a cosmetic queue-page banner.
 */
export async function assertSchedulerNotPaused(
  workItemId?: string,
): Promise<void> {
  const state = await getSchedulerState();
  if (!state.paused) return;
  await recordHealthRejection({ reason: "调度器已暂停", workItemId });
  throw new SchedulerPausedError();
}
