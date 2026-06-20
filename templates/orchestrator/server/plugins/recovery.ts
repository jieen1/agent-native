import { reconcileOnStartup } from "../recovery/reconcile.js";

// Crash-recovery on boot (DESIGN §14 / §1.7). The scheduler's in-memory run
// state is per-isolate, so a crash/redeploy leaves rows wedged at `running`.
// This plugin runs ONCE on startup to reconcile that durable state: re-queue
// stranded claimed/running work items (so exactly one worker re-claims), and
// re-drive stranded `running` workflow_runs (done NodeRuns replay from the
// journal at zero cost; a stranded running NodeRun re-runs whole). Every reaped
// row leaves an audit trail. Runs after the DB plugin (migrations) so the tables
// and the v18 audit_log exist. Best-effort: a reconcile error must not block
// boot, so it is caught — the durable reap/heartbeat ticks still recover later.
export default async function orchestratorRecoveryPlugin(): Promise<void> {
  try {
    await reconcileOnStartup();
  } catch {
    // Advisory on boot — the queue reap + node-run reap ticks still recover
    // stranded rows on their interval if the one-shot startup pass failed.
  }
}
