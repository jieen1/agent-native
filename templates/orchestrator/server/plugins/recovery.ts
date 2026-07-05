import { reconcileV3OnStartup } from "../recovery/v3-reconcile.js";
import { ensureV3Schema, isV3PostgresConfigured } from "../db/v3.js";
import { ensureBrainSchema } from "../db/brain-schema.js";

// Crash-recovery on boot (DESIGN §14 / §1.7). Runs after the DB plugin
// (migrations) so the tables and the v18 audit_log exist. Best-effort: a
// reconcile error must not block boot.
export default async function orchestratorRecoveryPlugin(): Promise<void> {
  // V3 recovery path. V3 runs on its own Postgres connection (DATABASE_URL_PG,
  // or a Postgres DATABASE_URL). Ensure the V3 schema exists first (idempotent),
  // then reconcile stranded runs.
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
