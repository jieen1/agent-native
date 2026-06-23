import { defineAction } from "@agent-native/core";
import { eq, ilike, and, desc, sql } from "drizzle-orm";
import { z } from "zod";
import { getV3Db, v3Schema } from "../server/db/v3.js";

/** List V3 runs with optional status/tag filters and pagination. */
export const runsList = defineAction({
  description: "List V3 runs with optional status and tag filters.",
  schema: z.object({
    status: z.string().optional(),
    tagMatch: z.string().optional(),
    limit: z.number().int().positive().default(50),
    offset: z.number().int().min(0).default(0),
  }),
  readOnly: true,
  run: async (args) => {
    const db = getV3Db();
    const conditions: Array<any> = [];

    if (args.status) {
      conditions.push(
        eq(v3Schema.v3Runs.status, args.status as any),
      );
    }

    const rows = await db
      .select({
        id: v3Schema.v3Runs.id,
        templateId: v3Schema.v3Runs.templateId,
        templateVersion: v3Schema.v3Runs.templateVersion,
        status: v3Schema.v3Runs.status,
        priority: v3Schema.v3Runs.priority,
        tags: v3Schema.v3Runs.tags,
        startedAt: v3Schema.v3Runs.startedAt,
        completedAt: v3Schema.v3Runs.completedAt,
      })
      .from(v3Schema.v3Runs)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(v3Schema.v3Runs.startedAt))
      .limit(args.limit)
      .offset(args.offset);

    // Filter by tag substring if requested
    let filtered = rows;
    if (args.tagMatch) {
      filtered = rows.filter((r) => {
        const tags = r.tags as Record<string, unknown> | string[] | null | undefined;
        if (!tags) return false;
        if (Array.isArray(tags)) {
          return tags.some((t) => String(t).includes(args.tagMatch!));
        }
        return Object.values(tags).some((v) =>
          String(v).includes(args.tagMatch!),
        );
      });
    }

    return filtered.map((r) => ({
      id: r.id,
      templateId: r.templateId,
      templateVersion: r.templateVersion,
      status: r.status,
      priority: r.priority,
      tags: r.tags,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
    }));
  },
});

/** Get V3 run state: run row + node status counts. */
export const runState = defineAction({
  description:
    "Get V3 run state: run details plus node status counts (pending/running/done/failed/skipped/awaiting-approval).",
  schema: z.object({
    runId: z.string(),
  }),
  readOnly: true,
  run: async (args) => {
    const db = getV3Db();

    const runRows = await db
      .select()
      .from(v3Schema.v3Runs)
      .where(eq(v3Schema.v3Runs.id, args.runId))
      .limit(1);
    if (!runRows.length) throw new Error(`Run '${args.runId}' not found`);
    const run = runRows[0];

    // Node status counts via GROUP BY
    const nodeRows = await db
      .select({
        status: v3Schema.v3Nodes.status,
        count: sql<number>`count(*)`.mapWith(Number),
      })
      .from(v3Schema.v3Nodes)
      .where(eq(v3Schema.v3Nodes.runId, args.runId))
      .groupBy(v3Schema.v3Nodes.status);

    const nodeCounts: Record<string, number> = {};
    for (const row of nodeRows) {
      nodeCounts[row.status] = row.count;
    }

    return {
      id: run.id,
      templateId: run.templateId,
      templateVersion: run.templateVersion,
      status: run.status,
      priority: run.priority,
      tags: run.tags,
      dagVersion: run.dagVersion,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      nodeCounts,
      totalNodes: nodeRows.reduce((sum, r) => sum + r.count, 0),
    };
  },
});

/** Cancel a V3 run. */
export const runCancel = defineAction({
  description: "Cancel a V3 run. Sets status to cancelled.",
  schema: z.object({
    runId: z.string(),
  }),
  run: async (args) => {
    const db = getV3Db();
    const rows = await db
      .select({ id: v3Schema.v3Runs.id, status: v3Schema.v3Runs.status })
      .from(v3Schema.v3Runs)
      .where(eq(v3Schema.v3Runs.id, args.runId))
      .limit(1);

    if (!rows.length) throw new Error(`Run '${args.runId}' not found`);
    const prev = rows[0].status;
    if (["done", "failed", "cancelled"].includes(prev)) {
      throw new Error(`Run is already ${prev}; cannot cancel`);
    }

    await db
      .update(v3Schema.v3Runs)
      .set({ status: "cancelled" as any, completedAt: new Date() })
      .where(eq(v3Schema.v3Runs.id, args.runId));

    // Cancel all running spawns for this run
    await db.execute(sql.raw(`
      UPDATE v3_spawns SET status = 'cancelled', completed_at = NOW()
      WHERE run_id = ${args.runId} AND status = 'running'
    `));

    return { runId: args.runId, previousStatus: prev, status: "cancelled" };
  },
});

/** Pause a V3 run. */
export const runPause = defineAction({
  description: "Pause a V3 run. Stops scheduling new nodes; running nodes wait.",
  schema: z.object({
    runId: z.string(),
  }),
  run: async (args) => {
    const db = getV3Db();
    await updateRunStatus(args.runId, "paused", ["running", "pending"]);
    return { runId: args.runId, status: "paused" };
  },
});

/** Resume a V3 run. */
export const runResume = defineAction({
  description: "Resume a paused V3 run.",
  schema: z.object({
    runId: z.string(),
  }),
  run: async (args) => {
    const db = getV3Db();
    await updateRunStatus(args.runId, "running", ["paused"]);
    return { runId: args.runId, status: "running" };
  },
});

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

async function updateRunStatus(
  runId: string,
  newStatus: string,
  allowedPrevious: string[],
): Promise<void> {
  const db = getV3Db();
  const rows = await db
    .select({ id: v3Schema.v3Runs.id, status: v3Schema.v3Runs.status })
    .from(v3Schema.v3Runs)
    .where(eq(v3Schema.v3Runs.id, runId))
    .limit(1);

  if (!rows.length) throw new Error(`Run '${runId}' not found`);
  if (!allowedPrevious.includes(rows[0].status)) {
    throw new Error(
      `Run is ${rows[0].status}; expected ${allowedPrevious.join(" or ")}`,
    );
  }

  await db
    .update(v3Schema.v3Runs)
    .set({ status: newStatus as any })
    .where(eq(v3Schema.v3Runs.id, runId));
}
