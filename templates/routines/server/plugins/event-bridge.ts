/**
 * Cross-process event-bridge poller plugin (Phase A3 §1.5.23).
 *
 * Mounts a `setInterval` (default 15s, beside the recurring-job scheduler) that
 * pulls events emitted by sibling app processes (`plan.created`,
 * `mail.message.received`, …) out of their durable `event_log` and dispatches
 * the ones matching enabled cross-app event routines through the SAME
 * condition + agentic path as same-process events.
 *
 * The poll core (`pollEventBridge`) lives in `@agent-native/core/event-log`
 * with all external seams injectable, so it is unit-tested with mocked
 * fetch / discovery / auth / dispatch and no real sibling app or OAuth
 * (§1.5.24). Here we only start the timer and wire the durable cursor store.
 */

import { pollEventBridge } from "@agent-native/core/event-log";
import { getEventCursor, setEventCursor } from "../event-cursors.js";

/** Poll interval — 15s default per §1.5.23 (beside the scheduler's 60s tick). */
const POLL_INTERVAL_MS = 15_000;
/** Startup delay so first poll runs after migrations/discovery settle. */
const POLL_START_DELAY_MS = 10_000;

export default function eventBridgePlugin(_nitroApp: unknown): void {
  let running = false;

  const tick = async (): Promise<void> => {
    // Skip overlapping passes — a slow fetch must not stack timers.
    if (running) return;
    running = true;
    try {
      await pollEventBridge({
        getCursor: getEventCursor,
        setCursor: setEventCursor,
      });
    } catch (err) {
      console.error("[event-bridge] poll pass failed:", err);
    } finally {
      running = false;
    }
  };

  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), POLL_INTERVAL_MS);
  }, POLL_START_DELAY_MS);
}
