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
}
