import { defineAction } from "@agent-native/core";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import { computeItemKeyDisplays } from "../server/lib/item-key-display.js";

export default defineAction({
  description: "List work items, optionally filtered to one project or status.",
  schema: z.object({
    projectId: z.string().optional().describe("Filter to a single project"),
    status: z
      .string()
      .optional()
      .describe("Filter by status (open|dispatched|done)"),
  }),
  http: { method: "GET" },
  run: async (args) => {
    const db = getDb();
    const where = and(
      ownerScope(schema.workItems),
      args.projectId
        ? eq(schema.workItems.projectId, args.projectId)
        : undefined,
      args.status ? eq(schema.workItems.status, args.status) : undefined,
    );
    const rows = await db
      .select({
        id: schema.workItems.id,
        projectId: schema.workItems.projectId,
        sprintId: schema.workItems.sprintId,
        itemKey: schema.workItems.itemKey,
        type: schema.workItems.type,
        title: schema.workItems.title,
        description: schema.workItems.description,
        status: schema.workItems.status,
        priority: schema.workItems.priority,
        risk: schema.workItems.risk,
        tags: schema.workItems.tags,
        currentStageName: schema.workItems.currentStageName,
        orchestratorThreadId: schema.workItems.orchestratorThreadId,
        dispatchedAt: schema.workItems.dispatchedAt,
        createdAt: schema.workItems.createdAt,
        updatedAt: schema.workItems.updatedAt,
        // F5 (v25): scale badge on list rows (S2 Briefs 列表行 / board).
        scaleEstimate: schema.workItems.scaleEstimate,
        splitParentId: schema.workItems.splitParentId,
      })
      .from(schema.workItems)
      .where(where)
      .orderBy(desc(schema.workItems.updatedAt));
    // F8: itemKey 消歧(读路径) — see server/lib/item-key-display.ts. Detects
    // duplicates against the FULL project population, not just this
    // (possibly status-filtered) batch.
    const displays = await computeItemKeyDisplays(
      db,
      rows.map((r) => ({ id: r.id, projectId: r.projectId, itemKey: r.itemKey })),
    );
    return rows.map((r) => ({
      ...r,
      tags: (() => {
        try {
          return JSON.parse(r.tags ?? "[]");
        } catch {
          return [];
        }
      })(),
      scaleEstimate: (() => {
        if (!r.scaleEstimate) return null;
        try {
          return JSON.parse(r.scaleEstimate);
        } catch {
          return null;
        }
      })(),
      itemKeyDisplay: displays.get(r.id) ?? r.itemKey,
    }));
  },
});
