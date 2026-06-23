// P4-A: Data lifecycle — additive columns for existing v3 tables.
// All changes are additive (no drop/rename/truncate).

import { v3DbExec } from "./v3.js";

const MIGRATIONS = [
  // v3_artifacts.expires_at — TTL boundary
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'v3_artifacts' AND column_name = 'expires_at') THEN ALTER TABLE v3_artifacts ADD COLUMN expires_at timestamptz; END IF; END $$`,
  // v3_artifacts.keep_after_run — opt-out from TTL cleanup
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'v3_artifacts' AND column_name = 'keep_after_run') THEN ALTER TABLE v3_artifacts ADD COLUMN keep_after_run integer NOT NULL DEFAULT 0; END IF; END $$`,
  // v3_runs.archived — soft-archived runs hidden from default list
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'v3_runs' AND column_name = 'archived') THEN ALTER TABLE v3_runs ADD COLUMN archived integer NOT NULL DEFAULT 0; END IF; END $$`,
];

/**
 * Ensure P4-A additive columns exist on the v3 tables.
 * Safe to call multiple times — each column guarded with COLUMN_EXISTS.
 */
export async function ensureP4Columns(): Promise<void> {
  for (const stmt of MIGRATIONS) {
    await v3DbExec(stmt);
  }
}
