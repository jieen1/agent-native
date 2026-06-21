/**
 * Routines app Drizzle schema.
 *
 * The only table the Routines app reads directly is `routine_runs` — the
 * core-owned, additive run-history table (see ROUTINES_DESIGN §5.2). Core
 * writes it from the scheduler / dispatcher hooks via the lazy `ensureTable`
 * pattern in `@agent-native/core/routine-runs`; this Drizzle definition lets
 * the app issue owner-scoped reads with `getDb`.
 *
 * The column set mirrors the core DDL exactly (TEXT id, two ownable columns,
 * integer ms timestamps). It is intentionally dialect-agnostic — the shared
 * `table`/`text`/`integer` helpers from `@agent-native/core/db/schema` compile
 * to SQLite or Postgres identically. Routine definitions themselves are NOT in
 * SQL: they live as `jobs/*.md` resources, so there is no routine table here.
 */

import { table, text, integer } from "@agent-native/core/db/schema";

/**
 * event_cursors — Routines-owned table for the cross-process event bridge
 * (Phase A3 §1.5.23). One row per (source_app, owner_email) records the last
 * `event_log.seq` the bridge poller pulled from that sibling app for that
 * owner, so a restart resumes without re-delivering and the same event is
 * processed exactly once (monotonic cursor).
 *
 * The composite primary key `(source_app, owner_email)` is declared in the
 * migration DDL (`server/plugins/db.ts`, version 2). This Drizzle definition
 * mirrors the columns for owner-scoped reads; writes go through a dialect-aware
 * upsert in `server/event-cursors.ts`.
 */
export const eventCursors = table("event_cursors", {
  sourceApp: text("source_app").notNull(),
  ownerEmail: text("owner_email").notNull().default("local@localhost"),
  cursor: integer("cursor").notNull().default(0),
});

export const routineRuns = table("routine_runs", {
  /** Caller-generated uuid (matches `chat_threads.id TEXT`). */
  id: text("id").primaryKey(),
  /** Ownable scope — every read filters on this. */
  ownerEmail: text("owner_email").notNull().default("local@localhost"),
  orgId: text("org_id"),
  /** `jobs/{name}.md` slug name of the routine that ran. */
  routineName: text("routine_name").notNull(),
  kind: text("kind", { enum: ["schedule", "event"] }).notNull(),
  /** Cron expression (schedule), event name (event), or "manual" (run-now). */
  trigger: text("trigger"),
  /** Chat thread the run created — the history row deep-links to it. */
  threadId: text("thread_id"),
  status: text("status", {
    enum: ["running", "success", "error", "skipped"],
  }).notNull(),
  error: text("error"),
  /** Epoch milliseconds. Sorted DESC for newest-first history. */
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"),
});

export const schema = { routineRuns, eventCursors };
