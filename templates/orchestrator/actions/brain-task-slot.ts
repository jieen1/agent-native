// brain-task-slot — F9 (orchestrator half): expose the newest brain_tasks row
// for a brain thread as a structured MCP action, so cross-app callers (the
// tracker's `get-activity.ts`) never reach into the orchestrator's private
// `brain_tasks` table over raw SQL (SDLC-034b / the `multi-app-workspace`
// doc's "no cross-app SQL" tenet).
//
// Design authority: docs/sdlc-impl-f5-f10.md §5A, the
// `actions/brain-task-slot.ts`(新,orchestrator) row: "暴露 brain_tasks 槽位
//状态(threadId→{status,runId,updatedAt}),ownerScope;替代 tracker 裸 SQL。"
//
// F0 integration note: the trunk previously also had an equivalent action,
// `brain-task-for-thread.ts` (`{status, runId}`, no `updatedAt`), called by
// the pre-F9 `templates/tracker/actions/get-activity.ts`. Per the F0
// cross-branch reconciliation, that duplicate has been REMOVED (grep-
// confirmed zero remaining callers inside `templates/orchestrator` — the only
// caller was the tracker template's own `get-activity.ts`, updated by the
// tracker-side F9 integration to call `"brain-task-slot"` instead). This is
// now the single action for reading a brain thread's task slot state.

import { defineAction } from "@agent-native/core";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getV3Db, v3Schema, resolveOwnerEmail } from "../server/db/index.js";

export default defineAction({
  description:
    "Get the newest orchestrator brain_task's { status, runId, updatedAt } " +
    "for a brain thread (queued | running | done | failed | cancelled). " +
    "Owner-scoped: returns nulls when no task is found for the caller's own " +
    "thread. Read-only replacement for the tracker's former raw-SQL read of " +
    "brain_tasks (SDLC-034b).",
  schema: z.object({
    threadId: z.string().min(1),
  }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    const db = getV3Db();
    // Fail-closed owner scope, mirroring brain-thread.ts / brain-task-for-thread.ts:
    // an absent identity resolves to the local single-user owner, never "any
    // owner's task".
    const ownerEmail = resolveOwnerEmail();

    const [task] = await db
      .select({
        status: v3Schema.brainTasks.status,
        runId: v3Schema.brainTasks.runId,
        updatedAt: v3Schema.brainTasks.updatedAt,
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
      updatedAt: task?.updatedAt
        ? new Date(task.updatedAt).toISOString()
        : null,
    };
  },
});
