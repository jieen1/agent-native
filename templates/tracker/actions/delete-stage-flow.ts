import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import { safeParseFlows, safeParseObject } from "../shared/stage-vocabulary.js";

// Delete a stage flow. Any work-item-type assignment pointing at the deleted
// flow is cleared back to "unassigned" (so create-work-item.ts falls back to
// the legacy default rather than silently resolving a stale flow id it can
// no longer find). Existing work items keep the plannedStages/flowId they
// were created with — this never touches tracker_work_items.
export default defineAction({
  description:
    "Delete a reusable stage flow from a project. Clears any work-item-type " +
    "assignment that pointed at it back to unassigned.",
  schema: z.object({
    projectId: z.string().min(1),
    id: z.string().min(1).describe("Flow id to delete"),
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

    const flows = safeParseFlows(project.stageFlows).filter(
      (f) => f.id !== args.id,
    );
    const typeAssignment = safeParseObject(
      project.stageTypeAssignment,
    ) as Record<string, string>;
    for (const type of Object.keys(typeAssignment)) {
      if (typeAssignment[type] === args.id) delete typeAssignment[type];
    }

    const now = new Date().toISOString();
    await db
      .update(schema.projects)
      .set({
        stageFlows: JSON.stringify(flows),
        stageTypeAssignment: JSON.stringify(typeAssignment),
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.projects.id, args.projectId),
          ownerScope(schema.projects),
        ),
      );

    return { id: args.id, deleted: true };
  },
});
