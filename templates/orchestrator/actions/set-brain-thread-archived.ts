// set-brain-thread-archived — archive or unarchive a brain session (thread).
//
// Archived threads are HIDDEN from the brain page's default session list (the
// "Archived" filter reveals them). Archiving is additive (a flag + timestamp on
// brain_threads) — it never deletes the session or its transcript. A running
// session cannot be archived (it is still doing work); the caller must wait or
// stop it first. Owner-scoped: a thread is only mutable by its owner.

import { defineAction } from "@agent-native/core";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getV3Db, v3Schema, resolveOwnerEmail } from "../server/db/index.js";
import { sql as drizzleSql } from "drizzle-orm";

export default defineAction({
  description:
    "Archive or unarchive an orchestrator brain session (thread). Archived " +
    "sessions are hidden from the default session list (the Archived filter " +
    "reveals them); their transcript is preserved. A running session cannot be " +
    "archived. Pass { threadId, archived }.",
  schema: z.object({
    threadId: z.string().min(1),
    archived: z.boolean(),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const db = getV3Db();
    // Fail-closed owner scope — a thread is only mutable by its owner.
    const ownerEmail = resolveOwnerEmail();
    const ownerScope = and(
      eq(v3Schema.brainThreads.id, args.threadId),
      eq(v3Schema.brainThreads.ownerEmail, ownerEmail),
    );

    const [thread] = await db
      .select({
        id: v3Schema.brainThreads.id,
        status: v3Schema.brainThreads.status,
        ownerEmail: v3Schema.brainThreads.ownerEmail,
      })
      .from(v3Schema.brainThreads)
      .where(ownerScope)
      .limit(1);

    if (!thread) throw new Error(`Brain thread '${args.threadId}' not found`);

    // Guard: don't archive an actively-working session. "Active" = either the
    // transient per-turn thread status is running, OR the durable task-level
    // state still holds a slot (a running/queued brain_task).
    if (args.archived) {
      const tasks = await db
        .select({ status: v3Schema.brainTasks.status })
        .from(v3Schema.brainTasks)
        .where(eq(v3Schema.brainTasks.threadId, args.threadId));
      const isActive =
        thread.status === "running" ||
        tasks.some((r) => r.status === "running" || r.status === "queued");
      if (isActive) {
        throw new Error(
          "Cannot archive a running session. Wait for it to finish or stop it first.",
        );
      }
    }

    await db
      .update(v3Schema.brainThreads)
      .set({
        archived: args.archived,
        archivedAt: args.archived ? drizzleSql`now()` : null,
      })
      .where(ownerScope);

    return { threadId: args.threadId, archived: args.archived };
  },
});
