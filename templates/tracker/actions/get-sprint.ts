import { defineAction } from "@agent-native/core";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import { computeItemKeyDisplays } from "../server/lib/item-key-display.js";

export default defineAction({
  description: "Get a single sprint with its bound work items.",
  schema: z.object({
    id: z.string().min(1).describe("Sprint id"),
  }),
  http: { method: "GET" },
  run: async (args) => {
    const db = getDb();
    const sprint = (
      await db
        .select()
        .from(schema.sprints)
        .where(and(eq(schema.sprints.id, args.id), ownerScope(schema.sprints)))
        .limit(1)
    )[0];
    if (!sprint) throw new Error("Sprint not found or not accessible");

    const rawItems = await db
      .select()
      .from(schema.workItems)
      .where(eq(schema.workItems.sprintId, args.id));

    // F8: itemKey 消歧(读路径) — SprintDetailPage reads its items via
    // useSprint→get-sprint (its OWN query, not list-work-items/get-work-item),
    // so it needs the same disambiguation applied explicitly or itemKeyDisplay
    // would be undefined and the page would fall back to the raw (possibly
    // duplicate) itemKey. See list-queue.ts for the same pattern.
    const displays = await computeItemKeyDisplays(
      db,
      rawItems.map((r) => ({
        id: r.id,
        projectId: r.projectId,
        itemKey: r.itemKey,
      })),
    );
    const items = rawItems.map((r) => ({
      ...r,
      itemKeyDisplay: displays.get(r.id) ?? r.itemKey,
    }));

    const { inArray } = await import("drizzle-orm");
    const stages =
      items.length > 0
        ? await db
            .select()
            .from(schema.stages)
            .where(
              inArray(
                schema.stages.workItemId,
                items.map((i) => i.id),
              ),
            )
        : [];

    return {
      id: sprint.id,
      projectId: sprint.projectId,
      name: sprint.name,
      goal: sprint.goal,
      status: sprint.status,
      phase: sprint.phase,
      executorThreadId: sprint.executorThreadId,
      branch: sprint.branch,
      startDate: sprint.startDate,
      endDate: sprint.endDate,
      createdAt: sprint.createdAt,
      updatedAt: sprint.updatedAt,
      items,
      stages,
      itemCount: items.length,
      delivered: items.filter((i) => i.status === "done").length,
    };
  },
});
