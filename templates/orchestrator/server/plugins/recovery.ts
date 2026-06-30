import { reconcileOnStartup } from "../recovery/reconcile.js";
import { reconcileV3OnStartup } from "../recovery/v3-reconcile.js";
import { ensureV3Schema, isV3PostgresConfigured } from "../db/v3.js";
import { ensureBrainSchema } from "../db/brain-schema.js";

// Crash-recovery on boot (DESIGN §14 / §1.7). The scheduler's in-memory run
// state is per-isolate, so a crash/redeploy leaves rows wedged at `running`.
// This plugin runs ONCE on startup to reconcile that durable state: re-queue
// stranded claimed/running work items (so exactly one worker re-claims), and
// re-drive stranded `running` workflow_runs (done NodeRuns replay from the
// journal at zero cost; a stranded running NodeRun re-runs whole). Every reaped
// row leaves an audit trail. Runs after the DB plugin (migrations) so the tables
// and the v18 audit_log exist. Best-effort: a reconcile error must not block
// boot, so it is caught — the durable reap/heartbeat ticks still recover later.
//
// G2: Also runs V3 startup reconcile as a separate path so V2 is not modified.
export default async function orchestratorRecoveryPlugin(): Promise<void> {
  // V2 recovery path (unchanged).
  try {
    await reconcileOnStartup();
  } catch {
    // Advisory on boot — the queue reap + node-run reap ticks still recover
    // stranded rows on their interval if the one-shot startup pass failed.
  }

  // G2: V3 recovery path — separate so V2 is never affected. V3 runs on its own
  // Postgres connection (DATABASE_URL_PG, or a Postgres DATABASE_URL). Ensure the
  // V3 schema exists first (idempotent), then reconcile stranded runs.
  if (isV3PostgresConfigured()) {
    try {
      await ensureV3Schema();
      // Brain tables (additive) — the persistent CC orchestrator session +
      // its transcript. Bootstrapped here so the brain page works on boot.
      await ensureBrainSchema();
      await reconcileV3OnStartup();
    } catch {
      // Best-effort — V3 runs will be re-ticked on their next event anyway.
    }
  }
}
