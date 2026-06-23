import { defineAction } from "@agent-native/core";
import { eq, and, desc, asc, sql } from "drizzle-orm";
import { z } from "zod";
import { getV3Db, v3Schema } from "../server/db/v3.js";

/**
 * List all node rows for a V3 run. Returns node id, nodeIdInDag, type, status,
 * iteration, fanoutIndex, timestamps, and error.
 */
export const v3RunNodes = defineAction({
  description:
    "List all node rows for a V3 run. Returns nodeId, type, status, iteration, fanoutIndex, timestamps, and error.",
  schema: z.object({
    runId: z.string(),
  }),
  readOnly: true,
  run: async (args) => {
    const db = getV3Db();

    const rows = await db
      .select({
        id: v3Schema.v3Nodes.id,
        runId: v3Schema.v3Nodes.runId,
        nodeIdInDag: v3Schema.v3Nodes.nodeIdInDag,
        type: v3Schema.v3Nodes.type,
        status: v3Schema.v3Nodes.status,
        iteration: v3Schema.v3Nodes.iteration,
        fanoutIndex: v3Schema.v3Nodes.fanoutIndex,
        currentSpawnId: v3Schema.v3Nodes.currentSpawnId,
        outputArtifactId: v3Schema.v3Nodes.outputArtifactId,
        startedAt: v3Schema.v3Nodes.startedAt,
        completedAt: v3Schema.v3Nodes.completedAt,
        error: v3Schema.v3Nodes.error,
      })
      .from(v3Schema.v3Nodes)
      .where(eq(v3Schema.v3Nodes.runId, args.runId))
      .orderBy(
        asc(v3Schema.v3Nodes.iteration),
        asc(v3Schema.v3Nodes.fanoutIndex),
      );

    return rows.map((r) => ({
      id: r.id,
      runId: r.runId,
      nodeIdInDag: r.nodeIdInDag,
      type: r.type,
      status: r.status,
      iteration: r.iteration,
      fanoutIndex: r.fanoutIndex,
      currentSpawnId: r.currentSpawnId,
      outputArtifactId: r.outputArtifactId,
      startedAt: r.startedAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      error: r.error,
    }));
  },
});

/**
 * Get the DAG definition for a run (from the run row or its template).
 * Returns nodes[] and their deps so the UI can render edges.
 */
export const v3RunDag = defineAction({
  description:
    "Get the DAG definition for a V3 run. Returns nodes array with ids, types, and deps for rendering the graph.",
  schema: z.object({
    runId: z.string(),
  }),
  readOnly: true,
  run: async (args) => {
    const db = getV3Db();

    const runRows = await db
      .select({ dag: v3Schema.v3Runs.dag })
      .from(v3Schema.v3Runs)
      .where(eq(v3Schema.v3Runs.id, args.runId))
      .limit(1);

    if (!runRows.length) {
      throw new Error(`Run '${args.runId}' not found`);
    }

    const dag = runRows[0].dag as
      | { nodes?: Array<{ id: string; type: string; deps?: string[] }> }
      | null;

    const nodes = dag?.nodes ?? [];
    const edges: Array<{ from: string; to: string }> = [];

    for (const node of nodes) {
      for (const dep of node.deps ?? []) {
        edges.push({ from: dep, to: node.id });
      }
    }

    return {
      nodes,
      edges,
      dagVersion: (dag as any)?.dagVersion ?? 1,
    };
  },
});

/**
 * List patches applied during a V3 run.
 */
export const v3RunPatches = defineAction({
  description:
    "List patch history for a V3 run. Returns patch operations and metadata for the timeline.",
  schema: z.object({
    runId: z.string(),
  }),
  readOnly: true,
  run: async (args) => {
    const db = getV3Db();

    const rows = await db
      .select({
        id: v3Schema.v3Patches.id,
        dagVersionBefore: v3Schema.v3Patches.dagVersionBefore,
        dagVersionAfter: v3Schema.v3Patches.dagVersionAfter,
        patchOps: v3Schema.v3Patches.patchOps,
        actor: v3Schema.v3Patches.actor,
        reason: v3Schema.v3Patches.reason,
        applied: v3Schema.v3Patches.applied,
        appliedAt: v3Schema.v3Patches.appliedAt,
      })
      .from(v3Schema.v3Patches)
      .where(eq(v3Schema.v3Patches.runId, args.runId))
      .orderBy(desc(v3Schema.v3Patches.appliedAt));

    return rows.map((r) => ({
      id: r.id,
      dagVersionBefore: r.dagVersionBefore,
      dagVersionAfter: r.dagVersionAfter,
      patchOps: r.patchOps,
      actor: r.actor,
      reason: r.reason,
      applied: Boolean(r.applied),
      appliedAt: r.appliedAt?.toISOString() ?? null,
    }));
  },
});

/**
 * List recent events for a V3 run (non-SSE fallback).
 */
export const v3RunEvents = defineAction({
  description:
    "List recent events for a V3 run (non-SSE). Returns event kind, payload, sequence number, and timestamp.",
  schema: z.object({
    runId: z.string(),
    limit: z.number().int().positive().default(200),
  }),
  readOnly: true,
  run: async (args) => {
    const db = getV3Db();

    const rows = await db
      .select({
        id: v3Schema.v3Events.id,
        kind: v3Schema.v3Events.kind,
        payload: v3Schema.v3Events.payload,
        seqNum: v3Schema.v3Events.seqNum,
        ts: v3Schema.v3Events.ts,
      })
      .from(v3Schema.v3Events)
      .where(eq(v3Schema.v3Events.runId, args.runId))
      .orderBy(asc(v3Schema.v3Events.seqNum))
      .limit(args.limit);

    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      payload: r.payload,
      seqNum: r.seqNum,
      ts: r.ts?.toISOString() ?? null,
    }));
  },
});

/** Retry a node — reset to ready, reconciler will re-spawn. */
export const nodeRetry = defineAction({
  description: "Retry a V3 node. Resets node status to ready.",
  schema: z.object({
    runId: z.string(),
    nodeId: z.string(),
  }),
  run: async (args) => {
    const db = getV3Db();
    const rows = await db
      .select({ id: v3Schema.v3Nodes.id, status: v3Schema.v3Nodes.status })
      .from(v3Schema.v3Nodes)
      .where(
        and(
          eq(v3Schema.v3Nodes.id, args.nodeId),
          eq(v3Schema.v3Nodes.runId, args.runId),
        ),
      )
      .limit(1);

    if (!rows.length) throw new Error(`Node '${args.nodeId}' not found in run`);
    const prev = rows[0].status;
    if (!["failed", "cancelled"].includes(prev)) {
      throw new Error(`Node is ${prev}; can only retry failed or cancelled nodes`);
    }

    await db
      .update(v3Schema.v3Nodes)
      .set({
        status: "ready" as any,
        startedAt: null,
        completedAt: null,
        error: null,
        currentSpawnId: null,
      })
      .where(eq(v3Schema.v3Nodes.id, args.nodeId));

    return { nodeId: args.nodeId, previousStatus: prev, status: "ready" };
  },
});

/** Skip a node — mark as skipped. */
export const nodeSkip = defineAction({
  description: "Skip a V3 node. Marks node as skipped.",
  schema: z.object({
    runId: z.string(),
    nodeId: z.string(),
  }),
  run: async (args) => {
    const db = getV3Db();
    const rows = await db
      .select({ id: v3Schema.v3Nodes.id, status: v3Schema.v3Nodes.status })
      .from(v3Schema.v3Nodes)
      .where(
        and(
          eq(v3Schema.v3Nodes.id, args.nodeId),
          eq(v3Schema.v3Nodes.runId, args.runId),
        ),
      )
      .limit(1);

    if (!rows.length) throw new Error(`Node '${args.nodeId}' not found in run`);
    if (["done", "skipped"].includes(rows[0].status)) {
      throw new Error(`Node is already ${rows[0].status}`);
    }

    await db
      .update(v3Schema.v3Nodes)
      .set({ status: "skipped" as any, completedAt: new Date() })
      .where(eq(v3Schema.v3Nodes.id, args.nodeId));

    return { nodeId: args.nodeId, status: "skipped" };
  },
});

/** Resolve a human_gate node (approve/reject). */
export const nodeResolveGate = defineAction({
  description: "Resolve a V3 human_gate node (approve or reject).",
  schema: z.object({
    runId: z.string(),
    nodeId: z.string(),
    choice: z.enum(["approve", "reject"]),
    note: z.string().optional(),
  }),
  run: async (args) => {
    const db = getV3Db();
    const rows = await db
      .select({ id: v3Schema.v3Nodes.id, status: v3Schema.v3Nodes.status })
      .from(v3Schema.v3Nodes)
      .where(
        and(
          eq(v3Schema.v3Nodes.id, args.nodeId),
          eq(v3Schema.v3Nodes.runId, args.runId),
        ),
      )
      .limit(1);

    if (!rows.length) throw new Error(`Node '${args.nodeId}' not found in run`);
    if (rows[0].status !== "awaiting-approval") {
      throw new Error(`Node is ${rows[0].status}; expected awaiting-approval`);
    }

    const newStatus = args.choice === "approve" ? "done" : "skipped";
    await db
      .update(v3Schema.v3Nodes)
      .set({ status: newStatus as any, completedAt: new Date() })
      .where(eq(v3Schema.v3Nodes.id, args.nodeId));

    // Store resolution as artifact
    const artifactId = crypto.randomUUID();
    await db.execute(sql.raw(`
      INSERT INTO v3_artifacts (id, spawn_id, text_content, object_content)
      VALUES (${artifactId}, NULL, ${JSON.stringify({ choice: args.choice, note: args.note ?? "" })}::text, ${JSON.stringify({ choice: args.choice, note: args.note ?? "" })}::jsonb)
    `));

    await db
      .update(v3Schema.v3Nodes)
      .set({ outputArtifactId: artifactId })
      .where(eq(v3Schema.v3Nodes.id, args.nodeId));

    return { nodeId: args.nodeId, choice: args.choice, status: newStatus };
  },
});
