import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

export default defineAction({
  description:
    "Create a work item under a project. Holds the requirement/intent only — " +
    "repo and branch come from the project (configured once), NOT the item.",
  schema: z.object({
    projectId: z.string().min(1).describe("Owning project id"),
    title: z.string().min(1).describe("Short work item title"),
    description: z
      .string()
      .optional()
      .describe("The requirement / intent handed to the orchestrator brain"),
    type: z
      .enum(["requirement", "task", "defect", "incident"])
      .optional()
      .describe("Work item type (default requirement)"),
    priority: z.coerce.number().int().optional().describe("Priority (higher = more urgent)"),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId() ?? null;

    const db = getDb();
    // Confirm the project exists and is visible to the caller.
    const project = (
      await db
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(and(eq(schema.projects.id, args.projectId), ownerScope(schema.projects)))
        .limit(1)
    )[0];
    if (!project) throw new Error("Project not found or not accessible");

    const id = nanoid();
    const now = new Date().toISOString();
    await db.insert(schema.workItems).values({
      id,
      projectId: args.projectId,
      type: args.type ?? "requirement",
      title: args.title.trim(),
      description: args.description?.trim() ?? "",
      status: "open",
      priority: args.priority ?? 0,
      createdAt: now,
      updatedAt: now,
      ownerEmail,
      orgId,
      visibility: "private",
    });

    return {
      id,
      projectId: args.projectId,
      type: args.type ?? "requirement",
      title: args.title.trim(),
      description: args.description?.trim() ?? "",
      status: "open",
      priority: args.priority ?? 0,
      createdAt: now,
      updatedAt: now,
    };
  },
});
