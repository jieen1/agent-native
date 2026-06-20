// Test DB setup: point the framework's getDb at a throwaway local sqlite file
// and create exactly the v2 engine tables the scheduler touches. This mirrors
// the additive DDL in server/plugins/db.ts (versions 8 & 10) so tests run
// against a real libsql DB without the full nitro migration runner.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

let dbUrl: string | null = null;

/** Create an isolated temp sqlite DB and set DATABASE_URL before getDb runs. */
export function useTempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "orch-engine-"));
  const file = join(dir, "test.db").replace(/\\/g, "/");
  dbUrl = `file:${file}`;
  process.env.DATABASE_URL = dbUrl;
  return dbUrl;
}

/** Create the engine tables (subset of server/plugins/db.ts, verbatim DDL). */
export async function createEngineTables(): Promise<void> {
  if (!dbUrl) throw new Error("call useTempDb() first");
  const c = createClient({ url: dbUrl });
  await c.execute(`CREATE TABLE IF NOT EXISTS workflow_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    graph TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    owner_email TEXT NOT NULL DEFAULT 'local@localhost',
    org_id TEXT,
    visibility TEXT NOT NULL DEFAULT 'private'
  )`);
  await c.execute(`CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL,
    work_item_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','paused','done','failed','cancelled')),
    deliverable TEXT,
    token_budget INTEGER,
    tokens_spent INTEGER NOT NULL DEFAULT 0,
    dynamic_authored INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    completed_at TEXT,
    owner_email TEXT NOT NULL DEFAULT 'local@localhost',
    org_id TEXT,
    visibility TEXT NOT NULL DEFAULT 'private'
  )`);
  await c.execute(`CREATE TABLE IF NOT EXISTS node_runs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    assignee TEXT,
    engine TEXT,
    model TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','running','done','failed','skipped','awaiting-approval')),
    iteration INTEGER NOT NULL DEFAULT 0,
    fanout_index INTEGER NOT NULL DEFAULT 0,
    dynamic INTEGER NOT NULL DEFAULT 0,
    input_ref TEXT,
    output_ref TEXT,
    error TEXT,
    agent_run_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    tokens_spent INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    completed_at TEXT,
    last_heartbeat TEXT
  )`);
  await c.execute(`CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    node_run_id TEXT,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    summary TEXT,
    created_at TEXT NOT NULL
  )`);
  await c.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS node_runs_journal_key_idx ON node_runs (run_id, node_id, iteration, fanout_index)`,
  );
  // Shares tables (structure only) so accessFilter joins resolve in tests that
  // exercise owner-scoped reads (e.g. the node-def reference scan).
  for (const t of ["workflow_template_shares", "workflow_run_shares"]) {
    await c.execute(`CREATE TABLE IF NOT EXISTS ${t} (
      id TEXT PRIMARY KEY,
      resource_id TEXT NOT NULL,
      principal_type TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
  }
}

/**
 * Create the P3a project-management tables (subset of server/plugins/db.ts v13,
 * verbatim DDL) + the v1 `tasks` table the backfill reads. Used by the work-item
 * + watchdog + backfill tests.
 */
export async function createPmTables(): Promise<void> {
  if (!dbUrl) throw new Error("call useTempDb() first");
  const c = createClient({ url: dbUrl });
  await c.execute(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','failed','cancelled')),
    workflow_id TEXT,
    result TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    owner_email TEXT NOT NULL DEFAULT 'local@localhost',
    org_id TEXT,
    visibility TEXT NOT NULL DEFAULT 'private'
  )`);
  await c.execute(`CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    working_dir TEXT NOT NULL DEFAULT '',
    git_remote TEXT,
    default_branch TEXT,
    default_workflow_id TEXT,
    status_schemes TEXT,
    environments TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    owner_email TEXT NOT NULL DEFAULT 'local@localhost',
    org_id TEXT,
    visibility TEXT NOT NULL DEFAULT 'private'
  )`);
  await c.execute(`CREATE TABLE IF NOT EXISTS work_items (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'task' CHECK(type IN ('requirement','bug','prod-issue','task')),
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    priority INTEGER NOT NULL DEFAULT 0,
    assignee TEXT,
    status TEXT NOT NULL DEFAULT '',
    status_category TEXT NOT NULL DEFAULT 'todo' CHECK(status_category IN ('todo','in-progress','completed','cancelled')),
    environment TEXT,
    severity TEXT,
    blocked INTEGER NOT NULL DEFAULT 0,
    blocked_reason TEXT,
    blocked_by TEXT,
    resolution TEXT,
    status_stale INTEGER NOT NULL DEFAULT 0,
    exec_state TEXT NOT NULL DEFAULT 'idle' CHECK(exec_state IN ('idle','queued','claimed','running','paused','failed','done')),
    claimed_at TEXT,
    claimed_by TEXT,
    workflow_id TEXT,
    workflow_run_id TEXT,
    deliverable TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    owner_email TEXT NOT NULL DEFAULT 'local@localhost',
    org_id TEXT,
    visibility TEXT NOT NULL DEFAULT 'private'
  )`);
  await c.execute(`CREATE TABLE IF NOT EXISTS work_item_links (
    id TEXT PRIMARY KEY,
    from_item TEXT NOT NULL,
    to_item TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('duplicate-of','blocks','blocked-by','relates-to')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  await c.execute(`CREATE TABLE IF NOT EXISTS work_item_status_log (
    id TEXT PRIMARY KEY,
    work_item_id TEXT NOT NULL,
    run_id TEXT,
    actor TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    blocked INTEGER NOT NULL DEFAULT 0,
    resolution TEXT,
    at TEXT NOT NULL
  )`);
  await c.execute(`CREATE TABLE IF NOT EXISTS node_defs (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    config TEXT NOT NULL DEFAULT '{}',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    owner_email TEXT NOT NULL DEFAULT 'local@localhost',
    org_id TEXT,
    visibility TEXT NOT NULL DEFAULT 'private'
  )`);
  await c.execute(
    `CREATE INDEX IF NOT EXISTS work_items_exec_priority_idx ON work_items (exec_state, priority)`,
  );
  await c.execute(
    `CREATE INDEX IF NOT EXISTS work_item_status_log_run_idx ON work_item_status_log (run_id)`,
  );
}
