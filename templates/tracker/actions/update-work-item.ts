import { defineAction } from "@agent-native/core";
import {
  getRequestOrgId,
  getRequestUserEmail,
} from "@agent-native/core/server/request-context";
import { eq, and } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

export default defineAction({
  description:
    "Update mutable fields on a work item (metadata, not status transitions). " +
    "F3: currentStageName is NOT settable here — every stage/status change is " +
    "guarded (see transition-work-item for human-driven transitions/closure, " +
    "or advance-stage for the evidence-backed writeback channel).",
  // .strict(): F3/T-F3-07 — currentStageName (and any other unrecognized
  // key) must be a SCHEMA-LEVEL rejection, not a silently-stripped no-op.
  // Without .strict(), zod's default "strip unknown keys" behavior would let
  // a currentStageName-carrying call through unrejected (it'd just be
  // dropped before ever reaching `run`), which defeats the whole point of
  // removing the field from the schema.
  schema: z
    .object({
      id: z.string().min(1),
      title: z.string().optional(),
      description: z.string().optional(),
      type: z.string().optional(),
      priority: z.number().int().optional(),
      risk: z.string().optional(),
      tags: z.array(z.string()).optional(),
      executionMode: z.string().optional(),
      sprintId: z.string().nullable().optional(),
      plannedStages: z.array(z.string()).optional(),
      branch: z.string().nullable().optional(),
      owner: z.string().nullable().optional(),
      nature: z.array(z.string()).optional(),
    })
    .strict(),
  http: { method: "POST" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

    const db = getDb();
    const existing = (
      await db
        .select()
        .from(schema.workItems)
        .where(
          and(eq(schema.workItems.id, args.id), ownerScope(schema.workItems)),
        )
        .limit(1)
    )[0];
    if (!existing) throw new Error("Work item not found");

    const now = new Date().toISOString();
    const patch: Partial<typeof schema.workItems.$inferInsert> = {
      updatedAt: now,
    };

    if (args.title !== undefined) patch.title = args.title;
    if (args.description !== undefined) patch.description = args.description;
    if (args.type !== undefined) patch.type = args.type;
    if (args.priority !== undefined) patch.priority = args.priority;
    if (args.risk !== undefined) patch.risk = args.risk;
    if (args.tags !== undefined) patch.tags = JSON.stringify(args.tags);
    if (args.executionMode !== undefined)
      patch.executionMode = args.executionMode;
    if (args.sprintId !== undefined) patch.sprintId = args.sprintId;
    if (args.plannedStages !== undefined)
      patch.plannedStages = JSON.stringify(args.plannedStages);
    if (args.branch !== undefined) patch.branch = args.branch;
    if (args.owner !== undefined) patch.owner = args.owner;
    if (args.nature !== undefined) patch.nature = JSON.stringify(args.nature);

    await db
      .update(schema.workItems)
      .set(patch)
      .where(
        and(eq(schema.workItems.id, args.id), ownerScope(schema.workItems)),
      );

    // R4b.2 Sprint Studio 问题池挂载 (§5.4): a sprintId change is the
    // "拖入 sprint" action — worth an activity entry, unlike this action's
    // other metadata patches which are silent. Only log a real change, not a
    // no-op write of the same value.
    if (args.sprintId !== undefined && args.sprintId !== existing.sprintId) {
      const orgId = getRequestOrgId() ?? null;
      await db.insert(schema.activities).values({
        id: nanoid(),
        workItemId: args.id,
        actorKind: "human",
        actorName: ownerEmail,
        eventType: args.sprintId ? "sprint.attach" : "sprint.detach",
        payload: JSON.stringify({
          fromSprintId: existing.sprintId,
          toSprintId: args.sprintId,
        }),
        createdAt: now,
        ownerEmail,
        orgId,
        visibility: "private",
      });
    }

    const updated = (
      await db
        .select()
        .from(schema.workItems)
        .where(eq(schema.workItems.id, args.id))
        .limit(1)
    )[0];

    return updated;
  },
});
