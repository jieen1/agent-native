import { startReapTick } from "../engine/reap.js";

// Durable stuck-run reaper (DESIGN §6.4/§13). A server-plugin tick, modeled on
// the framework's jobs/scheduler.ts loop, periodically returns stranded
// `running` NodeRuns (heartbeat older than the reap threshold) to failed so a
// crashed/redeployed scheduler never leaves a row wedged at running. The loop is
// `unref`-ed so it never blocks shutdown.
export default async function orchestratorReapPlugin(): Promise<void> {
  startReapTick();
}
