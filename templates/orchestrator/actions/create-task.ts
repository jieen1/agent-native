import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { newId, nowIso } from "./_util.js";

export default defineAction({
  description:
    "Create a new task. Optionally attach a workflow id to run it against.",
  schema: z.object({
    title: z.string().describe("Short task title"),
    description: z.string().optional().describe("What the task should achieve"),
    workflowId: z
      .string()
      .optional()
      .describe("Workflow to execute this task against"),
  }),
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId();
    const db = getDb();
    const now = nowIso();
    const id = newId("task");

    await db.insert(schema.tasks).values({
      id,
      title: args.title.trim() || "Untitled task",
      description: args.description?.trim() ?? "",
      status: "pending",
      workflowId: args.workflowId ?? null,
      result: null,
      createdAt: now,
      updatedAt: now,
      ownerEmail,
      orgId,
      visibility: "private",
    });

    return { id, title: args.title, status: "pending" as const };
  },
});
