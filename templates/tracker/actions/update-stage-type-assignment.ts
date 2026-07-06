import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import { safeParseFlows, safeParseObject } from "../shared/stage-vocabulary.js";

// Set (or clear) which stage flow a work-item type resolves to at creation
// time. Read by create-work-item.ts; a type with no entry here (the default
// for every project until this feature is configured) falls back to the
// legacy isNarrowScope two-branch default exactly as before.
export default defineAction({
  description:
    "Assign a work-item type to a stage flow (or clear the assignment, " +
    "falling back to the legacy default). Read by create-work-item.ts when " +
    "a new item of this type is created.",
  schema: z.object({
    projectId: z.string().min(1),
    type: z.string().min(1).describe("Work item type, e.g. 需求/任务/缺陷"),
    flowId: z
      .string()
      .nullable()
      .describe("Flow id to assign, or null to clear the assignment"),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

    const db = getDb();
    const project = (
      await db
        .select({
          id: schema.projects.id,
          stageFlows: schema.projects.stageFlows,
          stageTypeAssignment: schema.projects.stageTypeAssignment,
        })
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

    if (args.flowId) {
      const flows = safeParseFlows(project.stageFlows);
      if (!flows.some((f) => f.id === args.flowId)) {
        throw new Error(`Flow '${args.flowId}' not found on this project`);
      }
    }

    const typeAssignment = safeParseObject(
      project.stageTypeAssignment,
    ) as Record<string, string>;
    if (args.flowId) {
      typeAssignment[args.type] = args.flowId;
    } else {
      delete typeAssignment[args.type];
    }

    const now = new Date().toISOString();
    await db
      .update(schema.projects)
      .set({
        stageTypeAssignment: JSON.stringify(typeAssignment),
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.projects.id, args.projectId),
          ownerScope(schema.projects),
        ),
      );

    return { type: args.type, flowId: args.flowId ?? null };
  },
});
