// delete-brain-thread — hard-delete a brain session (thread) and its transcript.
//
// Removes the brain_threads row plus its brain_events transcript (and any
// brain_tasks queue rows) so the session is fully gone. A running session cannot
// be deleted (it is still doing work); archive instead, or wait/stop it first.
// Owner-scoped: only the thread's owner may delete it.

import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getV3Db, v3Schema } from "../server/db/v3.js";
import { ensureBrainSchema } from "../server/db/brain-schema.js";

export default defineAction({
  description:
    "Permanently delete an orchestrator brain session (thread) and its full " +
    "transcript (brain_events) and queue rows. A running session cannot be " +
    "deleted — archive it or stop it first. Pass { threadId }.",
  schema: z.object({
    threadId: z.string().min(1),
  }),
  http: { method: "POST" },
  run: async (args) => {
    await ensureBrainSchema();
    const db = getV3Db();
    const ownerEmail = getRequestUserEmail();

    const [thread] = await db
      .select({
        id: v3Schema.brainThreads.id,
        status: v3Schema.brainThreads.status,
        ownerEmail: v3Schema.brainThreads.ownerEmail,
      })
      .from(v3Schema.brainThreads)
      .where(eq(v3Schema.brainThreads.id, args.threadId))
      .limit(1);

    if (!thread) throw new Error(`Brain thread '${args.threadId}' not found`);
    if (ownerEmail && thread.ownerEmail !== ownerEmail) {
      throw new Error(`Brain thread '${args.threadId}' not found`);
    }

    // Don't delete an actively-working session.
    const tasks = await db
      .select({ status: v3Schema.brainTasks.status })
      .from(v3Schema.brainTasks)
      .where(eq(v3Schema.brainTasks.threadId, args.threadId));
    const isActive =
      thread.status === "running" ||
      tasks.some((r) => r.status === "running" || r.status === "queued");
    if (isActive) {
      throw new Error(
        "Cannot delete a running session. Wait for it to finish or stop it first.",
      );
    }

    // Clean transcript + queue rows, then the thread itself.
    await db
      .delete(v3Schema.brainEvents)
      .where(eq(v3Schema.brainEvents.threadId, args.threadId));
    await db
      .delete(v3Schema.brainTasks)
      .where(eq(v3Schema.brainTasks.threadId, args.threadId));
    await db
      .delete(v3Schema.brainThreads)
      .where(eq(v3Schema.brainThreads.id, args.threadId));

    return { threadId: args.threadId, deleted: true };
  },
});
