// set-brain-thread-title — rename a brain session (thread).
//
// The thread title defaults to the first task message (truncated). This action
// lets the user give a session a meaningful name. Owner-scoped; additive write.

import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getV3Db, v3Schema } from "../server/db/v3.js";
import { ensureBrainSchema } from "../server/db/brain-schema.js";

export default defineAction({
  description:
    "Rename an orchestrator brain session (thread). Sets the thread title shown " +
    "in the session list. Pass { threadId, title }.",
  schema: z.object({
    threadId: z.string().min(1),
    title: z.string().trim().min(1).max(200),
  }),
  http: { method: "POST" },
  run: async (args) => {
    await ensureBrainSchema();
    const db = getV3Db();
    const ownerEmail = getRequestUserEmail();

    const [thread] = await db
      .select({
        id: v3Schema.brainThreads.id,
        ownerEmail: v3Schema.brainThreads.ownerEmail,
      })
      .from(v3Schema.brainThreads)
      .where(eq(v3Schema.brainThreads.id, args.threadId))
      .limit(1);

    if (!thread) throw new Error(`Brain thread '${args.threadId}' not found`);
    if (ownerEmail && thread.ownerEmail !== ownerEmail) {
      throw new Error(`Brain thread '${args.threadId}' not found`);
    }

    await db
      .update(v3Schema.brainThreads)
      .set({ title: args.title })
      .where(eq(v3Schema.brainThreads.id, args.threadId));

    return { threadId: args.threadId, title: args.title };
  },
});
