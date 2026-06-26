// Brain schema bootstrap — additive DDL for the orchestrator brain tables.
//
// The brain is a persistent, resumable Claude Code session that reaches the
// orchestrator actions as MCP tools. `brain_threads` holds one CC session per
// thread (the `session_id` captured from stream-json is reused via --resume);
// `brain_events` is the append-only transcript the brain page polls.
//
// Mirrors the `ensureV3Schema` / `ensureP4Columns` convention: hand-written
// idempotent `CREATE TABLE IF NOT EXISTS` statements run via v3DbExec, so the
// brain does not depend on drizzle-kit migration generation. Drizzle table
// definitions for typed access live in v3-schema.ts (brainThreads/brainEvents).
//
// Additive only — never drops, renames, or destructively alters anything.

import { v3DbExec, isV3PostgresConfigured, getV3Db } from "./v3.js";

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS brain_threads (
     id           text PRIMARY KEY,
     title        text NOT NULL DEFAULT 'New session',
     session_id   text,
     status       text NOT NULL DEFAULT 'idle',
     workspace_id text,
     cwd          text,
     error        text,
     created_at   timestamptz DEFAULT now(),
     updated_at   timestamptz DEFAULT now(),
     owner_email  text NOT NULL DEFAULT 'local@localhost',
     org_id       text
   )`,
  `CREATE INDEX IF NOT EXISTS idx_brain_threads_owner ON brain_threads (owner_email)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_threads_updated ON brain_threads (updated_at)`,
  // Additive: brain monitor scheduler columns. monitor_interval_sec = periodic
  // drift-check cadence (NULL → env default, 0 → disabled); last_wake_at = the
  // last time any wake (event/timer/terminal) re-invoked this thread, used so
  // events reset the timer and the thread is never double-fired.
  `ALTER TABLE brain_threads ADD COLUMN IF NOT EXISTS monitor_interval_sec integer`,
  `ALTER TABLE brain_threads ADD COLUMN IF NOT EXISTS last_wake_at timestamptz`,
  // Additive: live model + context telemetry captured from the stream-json
  // child. model = the init `system` event's resolved model id (e.g.
  // claude-opus-4-8[1m]); context_window = result.modelUsage[model].contextWindow
  // (read, never hardcoded — opus-4-8[1m] = 1000000); context_used = the latest
  // assistant event usage (input + cache_read + cache_creation tokens);
  // last_usage = the raw usage object for the panel. All nullable / additive.
  `ALTER TABLE brain_threads ADD COLUMN IF NOT EXISTS model text`,
  `ALTER TABLE brain_threads ADD COLUMN IF NOT EXISTS context_window integer`,
  `ALTER TABLE brain_threads ADD COLUMN IF NOT EXISTS context_used integer`,
  `ALTER TABLE brain_threads ADD COLUMN IF NOT EXISTS last_usage jsonb`,
  // Additive: session-management archive flag. `archived` hides a thread from the
  // brain page's default session list (an "Archived" filter reveals it);
  // `archived_at` records when it was archived. Both nullable/defaulted, additive.
  `ALTER TABLE brain_threads ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false`,
  `ALTER TABLE brain_threads ADD COLUMN IF NOT EXISTS archived_at timestamptz`,
  `CREATE INDEX IF NOT EXISTS idx_brain_threads_archived ON brain_threads (archived)`,
  `CREATE TABLE IF NOT EXISTS brain_events (
     id           text PRIMARY KEY,
     thread_id    text NOT NULL,
     seq          integer NOT NULL,
     type         text NOT NULL,
     text         text,
     tool_name    text,
     tool_use_id  text,
     tool_input   jsonb,
     tool_result  jsonb,
     created_at   timestamptz DEFAULT now(),
     owner_email  text NOT NULL DEFAULT 'local@localhost',
     org_id       text
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS unique_brain_event_thread_seq ON brain_events (thread_id, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_events_thread ON brain_events (thread_id)`,
  // ── brain_tasks ────────────────────────────────────────────────────────────
  // The LEVEL-1 brain-task concurrency queue. Every dispatch (brain-send) inserts
  // a row `queued`; the admission gate promotes up to `degree` rows to `running`
  // (and only those start a `claude -p` brain child). A task occupies a slot from
  // admission until its bound run(s) reach terminal (the reconciler run-terminal
  // wake releases it) or the reaper releases it (dead thread / missed release).
  // Additive only.
  `CREATE TABLE IF NOT EXISTS brain_tasks (
     id           text PRIMARY KEY,
     thread_id    text NOT NULL,
     status       text NOT NULL DEFAULT 'queued',
     message      text,
     repo         text,
     base_branch  text,
     workspace_id text,
     tags         jsonb,
     owner_email  text NOT NULL DEFAULT 'local@localhost',
     org_id       text,
     priority     integer NOT NULL DEFAULT 0,
     run_id       text,
     claimed_at   timestamptz,
     created_at   timestamptz DEFAULT now(),
     updated_at   timestamptz DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_brain_tasks_status ON brain_tasks (status)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_tasks_thread ON brain_tasks (thread_id)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_tasks_owner ON brain_tasks (owner_email)`,
  `CREATE INDEX IF NOT EXISTS idx_brain_tasks_priority ON brain_tasks (priority, created_at)`,
  // ── spawn_events ─────────────────────────────────────────────────────────
  // The per-spawn INTERMEDIATE transcript for the run-detail Node Inspector:
  // ordered reasoning text + every tool call (name + input) + every tool result
  // a worker brain (claude-code analyze/review or vLLM develop) produced while
  // running a node. Mirrors brain_events; `seq` monotonic within a spawn. The
  // dispatcher persists these best-effort after a spawn returns — a logging
  // failure never fails the node. Additive only.
  `CREATE TABLE IF NOT EXISTS spawn_events (
     id           text PRIMARY KEY,
     spawn_id     text NOT NULL,
     seq          integer NOT NULL,
     type         text NOT NULL,
     name         text,
     input        jsonb,
     result       jsonb,
     text         text,
     created_at   timestamptz DEFAULT now(),
     owner_email  text NOT NULL DEFAULT 'local@localhost',
     org_id       text
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS unique_spawn_event_spawn_seq ON spawn_events (spawn_id, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_spawn_events_spawn ON spawn_events (spawn_id)`,
];

/**
 * Ensure the brain tables exist. Idempotent (CREATE … IF NOT EXISTS), gated on
 * Postgres being configured, best-effort (swallows `already exists`). Safe to
 * call on every boot. Returns silently when V3 Postgres is not configured.
 */
export async function ensureBrainSchema(): Promise<void> {
  if (!isV3PostgresConfigured()) return;
  getV3Db(); // initialize the pooled client used by v3DbExec
  for (const stmt of STATEMENTS) {
    try {
      await v3DbExec(stmt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/already exists/i.test(msg)) {
        console.warn(`[brain-migrate] statement failed: ${msg}`);
      }
    }
  }
  console.log("[brain-migrate] brain schema ensured");
}
