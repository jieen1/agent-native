import { startBrainMonitorTick } from "../brain/brain-monitor.js";
import { isPostgres } from "@agent-native/core/db";

// Brain monitor scheduler plugin — the CONFIGURABLE TIMED/periodic wake.
//
// Starts a durable server-plugin tick (modeled on engine/reap.ts) that, every
// MONITOR_TICK_MS, sweeps every ACTIVE brain-monitored run and wakes its brain
// when the per-thread periodic drift-check interval (monitor_interval_sec, env
// default BRAIN_MONITOR_INTERVAL_SEC) is due. Event-driven node/terminal wakes
// stamp the same last_wake_at, so events reset the timer and the scheduler is
// the backstop. The loop is `unref`-ed so it never blocks shutdown. Gated on V3
// Postgres being configured (the brain/run tables live there).
export default async function orchestratorBrainMonitorPlugin(): Promise<void> {
  if (!isPostgres()) return;
  startBrainMonitorTick();
}
