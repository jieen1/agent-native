import { defineAction } from "@agent-native/core";
import { eq, and, desc, sql, gte } from "drizzle-orm";
import { z } from "zod";

import { getV3Db, v3Schema, resolveOwnerEmail } from "../server/db/index.js";

/** List V3 runs with optional status/tag filters and pagination. */
export const runsList = defineAction({
  description:
    "List V3 runs with optional status, tagMatch (JSONB containment partial key/value match), since, and pagination filters.",
  schema: z.object({
    status: z.string().optional(),
    /**
     * Partial JSONB containment match — pass an object whose keys/values must
     * ALL appear in the run's tags column. E.g. { source: "tracker", item_id: "PAY-14" }.
     * Uses Postgres @> operator — O(1) via GIN index.
     */
    tagMatch: z.record(z.string(), z.string()).optional(),
    /** ISO-8601 datetime — return only runs started at or after this time. */
    since: z.string().datetime({ offset: true }).optional(),
    limit: z.number().int().positive().default(50),
    offset: z.number().int().min(0).default(0),
  }),
  readOnly: true,
  // Advertise on the A2A agent card so peer apps (e.g. tracker) can discover
  // this read-back surface for tag-match activity reassembly (v3-DESIGN §16).
  publicAgent: { expose: true, readOnly: true, requiresAuth: false },
  http: { method: "GET" },
  run: async (args) => {
    const db = getV3Db();
    const conditions: Array<import("drizzle-orm").SQL> = [];

    // Owner scope is ALWAYS applied (fail-closed). An absent request identity
    // resolves to the local single-user owner, never "all owners" — so no
    // caller, including an unauthenticated A2A peer, can enumerate another
    // owner's runs. (Previously this was gated behind `if (callerEmail)`, which
    // returned every owner's rows when the identity was empty — the O9 bug.)
    conditions.push(eq(v3Schema.v3Runs.ownerEmail, resolveOwnerEmail()));

    if (args.status) {
      conditions.push(eq(v3Schema.v3Runs.status, args.status as any));
    }

    // JSONB containment: tags @> $1::jsonb — matches when all supplied keys+values
    // are present in the stored JSONB. Far more correct than a substring scan.
    if (args.tagMatch && Object.keys(args.tagMatch).length > 0) {
      conditions.push(
        sql`${v3Schema.v3Runs.tags} @> ${JSON.stringify(args.tagMatch)}::jsonb`,
      );
    }

    if (args.since) {
      conditions.push(gte(v3Schema.v3Runs.startedAt, new Date(args.since)));
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

    return rows.map((r) => ({
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
  http: { method: "GET" },
  run: async (args) => {
    const db = getV3Db();

    // Fail-closed owner scope — the run is only visible to its owner.
    const runFilter = and(
      eq(v3Schema.v3Runs.id, args.runId),
      eq(v3Schema.v3Runs.ownerEmail, resolveOwnerEmail()),
    );

    const runRows = await db
      .select()
      .from(v3Schema.v3Runs)
      .where(runFilter)
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
    // Fail-closed owner scope — resolve once and reuse for read + write.
    const ownerEmail = resolveOwnerEmail();
    const runFilter = and(
      eq(v3Schema.v3Runs.id, args.runId),
      eq(v3Schema.v3Runs.ownerEmail, ownerEmail),
    );
    const rows = await db
      .select({ id: v3Schema.v3Runs.id, status: v3Schema.v3Runs.status })
      .from(v3Schema.v3Runs)
      .where(runFilter)
      .limit(1);

    if (!rows.length) throw new Error(`Run '${args.runId}' not found`);
    const prev = rows[0].status;
    if (["done", "failed", "cancelled"].includes(prev)) {
      throw new Error(`Run is already ${prev}; cannot cancel`);
    }

    await db
      .update(v3Schema.v3Runs)
      .set({ status: "cancelled" as any, completedAt: new Date() })
      .where(runFilter);

    // The run cancellation above already committed and IS the authoritative
    // outcome — R9 (docs/sdlc-product-design/02-workflows.md §4, SDLC-050)
    // requires runCancel be idempotent AND report success once it has taken
    // effect. Cancel all running spawns for this run as a best-effort
    // follow-up: a failure here (transient DB error, etc.) must never be
    // reported back as "cancel failed", which would mislead a caller into
    // re-cancelling an already-cancelled run or treating a real success as a
    // no-op. Uses the `sql` tagged template (NOT sql.raw): sql.raw
    // interpolates the runId as a bare, unquoted token, so Postgres reads it
    // as a column identifier and the query fails with "Failed query" every
    // time (a run could never actually be cancelled, and it was an injection
    // shape). The tagged template parameterizes ${args.runId}.
    let warning: string | undefined;
    try {
      await db.execute(sql`
        UPDATE v3_spawns SET status = 'cancelled', completed_at = NOW()
        WHERE run_id = ${args.runId} AND status = 'running'
      `);
    } catch (err) {
      warning = `Run cancelled, but clearing its running spawns failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      console.warn(
        `[v3-runs] runCancel: spawn cleanup failed for run ${args.runId}:`,
        err,
      );
    }

    return {
      runId: args.runId,
      previousStatus: prev,
      status: "cancelled",
      ...(warning ? { warning } : {}),
    };
  },
});

/** Pause a V3 run. */
export const runPause = defineAction({
  description:
    "Pause a V3 run. Stops scheduling new nodes; running nodes wait.",
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
  // Fail-closed owner scope — resolve once and reuse for read + write.
  const ownerEmail = resolveOwnerEmail();
  const runFilter = and(
    eq(v3Schema.v3Runs.id, runId),
    eq(v3Schema.v3Runs.ownerEmail, ownerEmail),
  );
  const rows = await db
    .select({ id: v3Schema.v3Runs.id, status: v3Schema.v3Runs.status })
    .from(v3Schema.v3Runs)
    .where(runFilter)
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
    .where(runFilter);
}
