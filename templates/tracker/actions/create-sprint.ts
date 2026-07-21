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
    "Create a sprint under a project. A sprint groups work items into a time-boxed delivery cycle.",
  schema: z.object({
    projectId: z.string().min(1).describe("Owning project id"),
    name: z.string().min(1).describe("Sprint name"),
    goal: z.string().optional().describe("Sprint goal or theme"),
    branch: z.string().optional().describe("Git branch the sprint targets"),
    startDate: z.string().optional().describe("Sprint start date (ISO-8601)"),
    endDate: z.string().optional().describe("Sprint end date (ISO-8601)"),
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
        .where(
          and(
            eq(schema.projects.id, args.projectId),
            ownerScope(schema.projects),
          ),
        )
        .limit(1)
    )[0];
    if (!project) throw new Error("Project not found or not accessible");

    const id = nanoid();
    const now = new Date().toISOString();
    await db.insert(schema.sprints).values({
      id,
      projectId: args.projectId,
      name: args.name.trim(),
      goal: args.goal?.trim() ?? "",
      status: "规划",
      phase: "planning",
      branch: args.branch?.trim() ?? "",
      startDate: args.startDate?.trim() ?? "",
      endDate: args.endDate?.trim() ?? "",
      createdAt: now,
      updatedAt: now,
      ownerEmail,
      orgId,
      visibility: "private",
    });

    return {
      id,
      projectId: args.projectId,
      name: args.name.trim(),
      goal: args.goal?.trim() ?? "",
      status: "规划",
      phase: "planning",
      branch: args.branch?.trim() ?? "",
      startDate: args.startDate?.trim() ?? "",
      endDate: args.endDate?.trim() ?? "",
      createdAt: now,
      updatedAt: now,
    };
  },
});
