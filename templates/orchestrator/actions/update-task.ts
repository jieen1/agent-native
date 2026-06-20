import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { nowIso } from "./_util.js";

// Single patch-style update. The orchestrator agent uses this to set a task's
// final status and delivered result; the UI uses it for title/description edits.
export default defineAction({
  description:
    "Update a task. Patch any of: title, description, status, result, workflowId.",
  schema: z.object({
    id: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    status: z
      .enum(["pending", "running", "done", "failed", "cancelled"])
      .optional(),
    result: z.string().optional().describe("Final delivered result (markdown)"),
    workflowId: z.string().nullable().optional(),
  }),
  run: async (args) => {
    const access = await resolveAccess("task", args.id);
    if (!access) throw new Error(`Task ${args.id} not found`);
    if (access.role === "viewer") throw new Error("Read-only access");

    const patch: Record<string, unknown> = { updatedAt: nowIso() };
    if (args.title !== undefined) patch.title = args.title;
    if (args.description !== undefined) patch.description = args.description;
    if (args.status !== undefined) patch.status = args.status;
    if (args.result !== undefined) patch.result = args.result;
    if (args.workflowId !== undefined) patch.workflowId = args.workflowId;

    const db = getDb();
    await db.update(schema.tasks).set(patch).where(eq(schema.tasks.id, args.id));
    return { id: args.id, ok: true };
  },
});
