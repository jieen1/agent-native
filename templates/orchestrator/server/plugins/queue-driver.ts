import { startQueueDriver } from "../queue/driver.js";

// Durable queue driver (DESIGN §6.4 D-3 / §13). A single server-plugin tick —
// modeled on the framework's jobs/scheduler.ts loop and the sibling reap plugin
// — owns draining the work-item queue through the worker pool AND the SQL
// heartbeat/reap that returns stranded claimed/running items to queued after a
// worker crash/redeploy. One durable owner prevents double-scheduling / strands.
// The loop is `unref`-ed so it never blocks shutdown. Settings are global/key-
// only, so the driver runs as the deployment-wide local user (§13 gotcha).
export default async function orchestratorQueueDriverPlugin(): Promise<void> {
  startQueueDriver();
}
