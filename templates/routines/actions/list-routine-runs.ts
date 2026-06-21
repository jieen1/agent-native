/**
 * List the current user's routine run history (newest first).
 *
 * Reads the core-owned `routine_runs` table (written by the scheduler /
 * dispatcher hooks, see `@agent-native/core/routine-runs`) through the app's
 * own Drizzle handle (`server/db`), scoped to the requesting owner. Each row is
 * mapped to a UI/agent view-model: routine name, kind, status, start/finish ISO
 * times, duration in ms, error message, and the `threadId` the run created so
 * the history UI can deep-link to the agent transcript.
 *
 * Owner-scope (`eq(routineRuns.ownerEmail, owner)`) is the cross-user isolation
 * boundary: user A never sees user B's runs. Optionally narrow to a single
 * routine with `--name`. On a brand-new database where no routine has ever run,
 * the table read is wrapped so a missing table reads as an empty history.
 *
 * Usage:
 *   pnpm action list-routine-runs
 *   pnpm action list-routine-runs --name=morning-briefing --limit=20
 */

import { defineAction } from "@agent-native/core/action";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { requireOwnerEmail } from "./_routines-lib.js";

interface RoutineRunView {
  id: string;
  routineName: string;
  kind: "schedule" | "event";
  /** Cron expression, event name, or "manual" (run-now). */
  trigger: string | null;
  status: "running" | "success" | "error" | "skipped";
  /** Chat thread the run created; null when the run failed before thread creation. */
  threadId: string | null;
  /** ISO timestamp the run started. */
  startedAt: string;
  /** ISO timestamp the run reached a terminal status; null while running. */
  finishedAt: string | null;
  /** Wall-clock duration in ms; null while still running. */
  durationMs: number | null;
  /** Failure message; null unless status is "error". */
  error: string | null;
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function toIso(ms: number | null): string | null {
  if (ms == null) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export default defineAction({
  description:
    "List the current user's routine run history, newest first. Returns each run's routine name, kind, trigger, status (running/success/error/skipped), start/finish times, duration in ms, error message, and the chat thread id to inspect what the agent did. Optionally filter by routine name. Use this to answer 'did my routine run' or 'why did it fail'.",
  schema: z.object({
    name: z
      .string()
      .optional()
      .describe("Narrow to a single routine's runs by its slug name."),
    limit: z
      .number()
      .int()
      .positive()
      .max(MAX_LIMIT)
      .default(DEFAULT_LIMIT)
      .describe(`Maximum number of runs to return (1-${MAX_LIMIT}).`),
  }),
  http: { method: "GET" },
  run: async (args) => {
    const owner = requireOwnerEmail();
    const db = await getDb();
    const { routineRuns } = schema;

    const whereClause = args.name
      ? and(
          eq(routineRuns.ownerEmail, owner),
          eq(routineRuns.routineName, args.name),
        )
      : eq(routineRuns.ownerEmail, owner);

    let rows: Array<typeof routineRuns.$inferSelect>;
    try {
      rows = await db
        .select()
        .from(routineRuns)
        .where(whereClause)
        .orderBy(desc(routineRuns.startedAt))
        .limit(args.limit);
    } catch (err) {
      // The table may not exist yet on a brand-new database that has never run
      // a routine. Treat that as an empty history rather than an error.
      console.error(
        "[list-routine-runs] read failed (treating as empty history):",
        err instanceof Error ? err.message : err,
      );
      return { runs: [] as RoutineRunView[] };
    }

    const runs: RoutineRunView[] = rows.map((row) => ({
      id: row.id,
      routineName: row.routineName,
      kind: row.kind,
      trigger: row.trigger ?? null,
      status: row.status,
      threadId: row.threadId ?? null,
      startedAt: toIso(row.startedAt) ?? new Date(row.startedAt).toISOString(),
      finishedAt: toIso(row.finishedAt),
      durationMs:
        row.finishedAt != null ? row.finishedAt - row.startedAt : null,
      error: row.error ?? null,
    }));

    return { runs };
  },
});
