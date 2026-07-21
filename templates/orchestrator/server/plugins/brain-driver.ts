import { isPostgres } from "@agent-native/core/db";

import { startBrainDriver } from "../queue/brain-driver.js";

// LEVEL-1 brain-task driver plugin — the durable admission/reap loop for the
// brain concurrency limiter. Auto-loaded on boot. Gated on V3 Postgres being
// configured (the brain_tasks table lives there). The tick promotes queued brain
// tasks to running up to the configured `brain-concurrency`, releases slots
// stranded by a missed run-terminal release, and prunes orphaned git worktrees.
// The loop is `unref`-ed so it never blocks shutdown. Mirrors the v2
// queue-driver plugin shape.
export default async function orchestratorBrainDriverPlugin(): Promise<void> {
  if (!isPostgres()) return;
  startBrainDriver();
}
