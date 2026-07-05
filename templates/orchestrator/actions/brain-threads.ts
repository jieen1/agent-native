// brain-threads — list the current owner's brain threads for session management.
//
// The brain page's session rail lists past + active sessions so the user can
// resume, rename, archive, or delete them; sending a message to a thread resumes
// its SAME Claude Code session.
//
// LIST-COMPLETENESS FIX: the previous version capped the list at a hard
// `limit: 50` default. With 66+ threads that silently DROPPED the oldest 16 —
// and any running thread beyond the first 50 rows would vanish from the page.
// We now return ALL of the owner's threads by default (pagination is opt-in via
// `limit`) and order running sessions FIRST, then newest-updated. We report each
// thread's OWN `status` faithfully (running | done | error | queued | idle) — the
// page must mirror brain_threads, not the task-queue slot state.
//
// Adds session-management params: free-text search (title/id), a status filter,
// sort order, and include-archived. Archived threads are hidden by default.

import { defineAction } from "@agent-native/core";
import { and, eq, or, ilike, sql } from "drizzle-orm";
import { z } from "zod";
import { getV3Db, v3Schema, resolveOwnerEmail } from "../server/db/v3.js";
import { ensureBrainSchema } from "../server/db/brain-schema.js";
import { isV3PostgresConfigured } from "../server/db/v3.js";

export default defineAction({
  description:
    "List the orchestrator brain threads (persistent, resumable Claude Code " +
    "sessions) for the current user. Running sessions first, then newest. " +
    "Returns every thread by default (no silent cap). Supports search " +
    "(title/id), a status filter, sort order, and include-archived for session " +
    "management. Use to resume a past session.",
  schema: z.object({
    /** Free-text filter on title or id (case-insensitive, substring). */
    search: z.string().trim().optional(),
    /** Filter by the thread's own status. "all" returns every status. */
    status: z
      .enum(["all", "running", "queued", "done", "error"])
      .default("all"),
    /** Sort order by updatedAt (running sessions are always grouped first). */
    sort: z.enum(["recent", "oldest"]).default("recent"),
    /** Include archived threads. Default false → archived hidden. */
    includeArchived: z.boolean().default(false),
    /** Optional cap. Omit to return all of the owner's threads. */
    limit: z.number().int().positive().max(500).optional(),
  }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    if (!isV3PostgresConfigured()) return [];
    await ensureBrainSchema();
    const db = getV3Db();
    // Fail-closed owner scope — ALWAYS list only the resolved owner's threads.
    // An absent identity resolves to the local single-user owner, never every
    // owner's threads (the O9 fail-open bug was `if (ownerEmail)`).
    const ownerEmail = resolveOwnerEmail();

    const conds = [] as ReturnType<typeof eq>[];
    conds.push(eq(v3Schema.brainThreads.ownerEmail, ownerEmail));
    if (!args.includeArchived)
      conds.push(eq(v3Schema.brainThreads.archived, false));
    if (args.status !== "all")
      conds.push(eq(v3Schema.brainThreads.status, args.status));
    if (args.search) {
      const like = `%${args.search}%`;
      conds.push(
        or(
          ilike(v3Schema.brainThreads.title, like),
          ilike(v3Schema.brainThreads.id, like),
        ) as ReturnType<typeof eq>,
      );
    }

    // Running sessions first (so they never get pushed off a paginated view),
    // then by updatedAt in the requested direction.
    const runningFirst = sql`CASE WHEN ${v3Schema.brainThreads.status} = 'running' THEN 0 ELSE 1 END`;
    const updatedOrder =
      args.sort === "oldest"
        ? sql`${v3Schema.brainThreads.updatedAt} ASC`
        : sql`${v3Schema.brainThreads.updatedAt} DESC`;

    let q = db
      .select({
        id: v3Schema.brainThreads.id,
        title: v3Schema.brainThreads.title,
        sessionId: v3Schema.brainThreads.sessionId,
        status: v3Schema.brainThreads.status,
        model: v3Schema.brainThreads.model,
        workspaceId: v3Schema.brainThreads.workspaceId,
        archived: v3Schema.brainThreads.archived,
        archivedAt: v3Schema.brainThreads.archivedAt,
        createdAt: v3Schema.brainThreads.createdAt,
        updatedAt: v3Schema.brainThreads.updatedAt,
      })
      .from(v3Schema.brainThreads)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(runningFirst, updatedOrder)
      .$dynamic();

    if (args.limit) q = q.limit(args.limit);

    const rows = await q;

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      sessionId: r.sessionId,
      hasSession: !!r.sessionId,
      // The thread's own status (faithfully mirrors brain_threads). The page
      // uses this for the status chip; effectiveStatus is kept as an alias so
      // the existing client interface stays satisfied.
      status: r.status,
      effectiveStatus: r.status,
      model: r.model ?? null,
      workspaceId: r.workspaceId ?? null,
      archived: r.archived === true,
      archivedAt: r.archivedAt ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  },
});
