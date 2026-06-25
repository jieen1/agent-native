import { defineAction } from "@agent-native/core";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

export default defineAction({
  description: "Get a single work item with its owning project context.",
  schema: z.object({
    id: z.string().min(1).describe("Work item id"),
  }),
  http: { method: "GET" },
  run: async (args) => {
    const db = getDb();
    const item = (
      await db
        .select()
        .from(schema.workItems)
        .where(and(eq(schema.workItems.id, args.id), ownerScope(schema.workItems)))
        .limit(1)
    )[0];
    if (!item) throw new Error("Work item not found or not accessible");

    const project = (
      await db
        .select({
          id: schema.projects.id,
          key: schema.projects.key,
          name: schema.projects.name,
          gitRemote: schema.projects.gitRemote,
          defaultBranch: schema.projects.defaultBranch,
        })
        .from(schema.projects)
        .where(eq(schema.projects.id, item.projectId))
        .limit(1)
    )[0];

    return {
      id: item.id,
      projectId: item.projectId,
      type: item.type,
      title: item.title,
      description: item.description,
      status: item.status,
      priority: item.priority,
      orchestratorThreadId: item.orchestratorThreadId,
      orchestratorWorkspaceId: item.orchestratorWorkspaceId,
      dispatchedAt: item.dispatchedAt,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      project: project ?? null,
    };
  },
});
