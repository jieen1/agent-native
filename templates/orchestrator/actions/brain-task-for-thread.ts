// brain-task-for-thread — read the newest brain_tasks row for a brain thread.
//
// The tracker (over MCP) needs the ACCURATE per-item slot state
// (queued | running | done | failed | cancelled) for a dispatched work item,
// keyed by the brain thread it created. `runsList` alone cannot represent the
// pre-admission "queued" window: a brain_task can sit at status `queued` for a
// while before the admission gate promotes it and a DAG run even exists, so
// deriving slot state from runs alone silently drops that window. This action
// answers straight from the source of truth (`brain_tasks`) instead.
//
// Owner-scoped exactly like brain-thread.ts / brain-threads.ts: fail-closed via
// `resolveOwnerEmail()`, filtered directly into the WHERE clause so an absent
// identity resolves to the local single-user owner, never "any owner's task".
// brain_tasks carries its own `owner_email` (set at enqueue time in
// brain-send.ts, the same value as the owning brain_threads row), so this reads
// brain_tasks directly without a join — a foreign thread's task simply isn't
// found, matching the fail-closed pattern of the other V3 read actions.

import { defineAction } from "@agent-native/core";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getV3Db, v3Schema, resolveOwnerEmail } from "../server/db/v3.js";

export default defineAction({
  description:
    "Get the newest orchestrator brain_task's { status, runId } for a brain " +
    "thread (queued | running | done | failed | cancelled) — the accurate " +
    "per-item slot state, including the pre-admission queued window a DAG-run " +
    "list can't see. Owner-scoped: returns nulls when no task is found for the " +
    "caller's own thread.",
  schema: z.object({
    threadId: z.string().min(1),
  }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    const db = getV3Db();
    // Fail-closed owner scope, mirroring brain-thread.ts: an absent identity
    // resolves to the local single-user owner, never "any owner's task".
    const ownerEmail = resolveOwnerEmail();

    const [task] = await db
      .select({
        status: v3Schema.brainTasks.status,
        runId: v3Schema.brainTasks.runId,
      })
      .from(v3Schema.brainTasks)
      .where(
        and(
          eq(v3Schema.brainTasks.threadId, args.threadId),
          eq(v3Schema.brainTasks.ownerEmail, ownerEmail),
        ),
      )
      .orderBy(desc(v3Schema.brainTasks.createdAt))
      .limit(1);

    return {
      status: task?.status ?? null,
      runId: task?.runId ?? null,
    };
  },
});
