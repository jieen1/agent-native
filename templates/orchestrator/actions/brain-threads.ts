// brain-threads — list the current owner's brain threads (for resume).
//
// The brain page's left rail lists past sessions so the user can resume them;
// sending a message to a thread resumes its SAME Claude Code session.

import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { eq, desc } from "drizzle-orm";
import { z } from "zod";
import { getV3Db, v3Schema } from "../server/db/v3.js";

export default defineAction({
  description:
    "List the orchestrator brain threads (persistent, resumable Claude Code " +
    "sessions) for the current user, newest first. Use to resume a past session.",
  schema: z.object({
    limit: z.number().int().positive().max(200).default(50),
  }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    const db = getV3Db();
    const ownerEmail = getRequestUserEmail();

    const rows = await db
      .select({
        id: v3Schema.brainThreads.id,
        title: v3Schema.brainThreads.title,
        sessionId: v3Schema.brainThreads.sessionId,
        status: v3Schema.brainThreads.status,
        workspaceId: v3Schema.brainThreads.workspaceId,
        createdAt: v3Schema.brainThreads.createdAt,
        updatedAt: v3Schema.brainThreads.updatedAt,
      })
      .from(v3Schema.brainThreads)
      .where(
        ownerEmail
          ? eq(v3Schema.brainThreads.ownerEmail, ownerEmail)
          : undefined,
      )
      .orderBy(desc(v3Schema.brainThreads.updatedAt))
      .limit(args.limit);

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      sessionId: r.sessionId,
      hasSession: !!r.sessionId,
      status: r.status,
      workspaceId: r.workspaceId,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  },
});
