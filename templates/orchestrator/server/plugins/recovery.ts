import { isPostgres } from "@agent-native/core/db";

import { reconcileV3OnStartup } from "../recovery/v3-reconcile.js";

// Crash-recovery on boot (DESIGN §14 / §1.7). Runs after the DB plugin
// (migrations) so the tables and the v18 audit_log exist. Best-effort: a
// reconcile error must not block boot.
export default async function orchestratorRecoveryPlugin(): Promise<void> {
  // V3 recovery path. V3 shares the framework's Postgres database — its
  // schema (+ the brain tables) is created by the DB plugin's migrations
  // (server/plugins/db.ts, migrateV3) before this plugin runs, so there is no
  // separate schema-ensure step here anymore. Just reconcile stranded runs.
  if (isPostgres()) {
    try {
      await reconcileV3OnStartup();
    } catch {
      // Best-effort — V3 runs will be re-ticked on their next event anyway.
    }
  }
}
