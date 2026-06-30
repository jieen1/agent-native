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

    const sprint = item.sprintId
      ? (
          await db
            .select({
              id: schema.sprints.id,
              name: schema.sprints.name,
              status: schema.sprints.status,
            })
            .from(schema.sprints)
            .where(eq(schema.sprints.id, item.sprintId))
            .limit(1)
        )[0] ?? null
      : null;

    return {
      id: item.id,
      projectId: item.projectId,
      type: item.type,
      title: item.title,
      description: item.description,
      status: item.status,
      priority: item.priority,
      orchestratorThreadId: item.orchestratorThreadId,
      orchestratorTaskId: item.orchestratorTaskId,
      orchestratorRunId: item.orchestratorRunId,
      orchestratorWorkspaceId: item.orchestratorWorkspaceId,
      dispatchedAt: item.dispatchedAt,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      sprintId: item.sprintId,
      itemKey: item.itemKey,
      risk: item.risk,
      tags: (() => { try { return JSON.parse(item.tags ?? "[]"); } catch { return []; } })(),
      executionMode: item.executionMode,
      currentStageName: item.currentStageName,
      plannedStages: (() => { try { return JSON.parse(item.plannedStages ?? "[]"); } catch { return []; } })(),
      branch: item.branch,
      sprint: sprint ?? null,
      project: project ?? null,
    };
  },
});
