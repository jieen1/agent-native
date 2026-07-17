// brain-thread — read one brain thread + its full transcript for the page poll.
//
// Returns the thread row (status, session_id, workspace) and the ordered event
// list (user / assistant / tool_use / tool_result / result / error). The brain
// page polls this ~1.5s while the thread is running to render a live transcript.

import { defineAction } from "@agent-native/core";
import { and, eq, asc } from "drizzle-orm";
import { z } from "zod";

import { getV3Db, v3Schema, resolveOwnerEmail } from "../server/db/index.js";

export default defineAction({
  description:
    "Get one orchestrator brain thread plus its ordered transcript (user / " +
    "assistant text / MCP tool calls with input+result / result / error). Poll " +
    "this to render the live brain console while a thread is running.",
  schema: z.object({
    threadId: z.string().min(1),
  }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    const db = getV3Db();
    // Fail-closed owner scope: a thread is only visible to its owner (V3 has no
    // shares). The SELECT is owner-scoped so a foreign thread simply isn't found
    // — an absent identity resolves to the local owner, never "any thread".
    const ownerEmail = resolveOwnerEmail();

    const [thread] = await db
      .select()
      .from(v3Schema.brainThreads)
      .where(
        and(
          eq(v3Schema.brainThreads.id, args.threadId),
          eq(v3Schema.brainThreads.ownerEmail, ownerEmail),
        ),
      )
      .limit(1);

    if (!thread) throw new Error(`Brain thread '${args.threadId}' not found`);

    const events = await db
      .select({
        id: v3Schema.brainEvents.id,
        seq: v3Schema.brainEvents.seq,
        type: v3Schema.brainEvents.type,
        text: v3Schema.brainEvents.text,
        toolName: v3Schema.brainEvents.toolName,
        toolUseId: v3Schema.brainEvents.toolUseId,
        toolInput: v3Schema.brainEvents.toolInput,
        toolResult: v3Schema.brainEvents.toolResult,
        createdAt: v3Schema.brainEvents.createdAt,
      })
      .from(v3Schema.brainEvents)
      .where(eq(v3Schema.brainEvents.threadId, args.threadId))
      .orderBy(asc(v3Schema.brainEvents.seq));

    return {
      thread: {
        id: thread.id,
        title: thread.title,
        sessionId: thread.sessionId,
        status: thread.status,
        workspaceId: thread.workspaceId,
        cwd: thread.cwd,
        error: thread.error,
        // F7 turn-terminal-state contract (04 §6, SDLC-060): non-null only when
        // a delivered turn's closing race reported error_during_execution — the
        // thread stayed `done` and the raw anomaly text landed here instead of
        // misclassifying the turn as failed.
        closingAnomaly: thread.closingAnomaly,
        monitorIntervalSec: thread.monitorIntervalSec,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      },
      events,
    };
  },
});
