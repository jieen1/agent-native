import { defineAction } from "@agent-native/core";
import { eq, and, desc, asc, sql } from "drizzle-orm";
import { z } from "zod";

import { getV3Db, v3Schema, resolveOwnerEmail } from "../server/db/index.js";

/**
 * Returns a WHERE clause that constrains runId + owner, ALWAYS (fail-closed).
 * The owner resolves to the local single-user identity when the request has no
 * authenticated user, so an absent identity scopes to that owner's rows — never
 * every owner's. All the run-detail reads (nodes/events/dag/patches) gate on
 * this via assertRunAccess, so they inherit the same scope.
 */
function runOwnerFilter(runId: string) {
  return and(
    eq(v3Schema.v3Runs.id, runId),
    eq(v3Schema.v3Runs.ownerEmail, resolveOwnerEmail()),
  );
}

/** Verifies run exists and belongs to caller; throws if not found. */
async function assertRunAccess(
  db: ReturnType<typeof getV3Db>,
  runId: string,
): Promise<void> {
  const rows = await db
    .select({ id: v3Schema.v3Runs.id })
    .from(v3Schema.v3Runs)
    .where(runOwnerFilter(runId))
    .limit(1);
  if (!rows.length) throw new Error(`Run '${runId}' not found`);
}

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
  http: { method: "GET" },
  run: async (args) => {
    const db = getV3Db();
    await assertRunAccess(db, args.runId);

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
  http: { method: "GET" },
  run: async (args) => {
    const db = getV3Db();

    const runRows = await db
      .select({ dag: v3Schema.v3Runs.dag })
      .from(v3Schema.v3Runs)
      .where(runOwnerFilter(args.runId))
      .limit(1);

    if (!runRows.length) {
      throw new Error(`Run '${args.runId}' not found`);
    }

    const dag = runRows[0].dag as {
      nodes?: Array<{ id: string; type: string; deps?: string[] }>;
    } | null;

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
  http: { method: "GET" },
  run: async (args) => {
    const db = getV3Db();
    await assertRunAccess(db, args.runId);

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
  http: { method: "GET" },
  run: async (args) => {
    const db = getV3Db();
    await assertRunAccess(db, args.runId);

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

// Terminal node statuses — mirrors the private TERMINAL_STATUSES set in
// server/engine/v3-reconciler.ts (done/failed/skipped). Used only to decide
// the R9 conduction-gap admission branch below.
const TERMINAL_NODE_STATUSES = new Set(["done", "failed", "skipped"]);
// Terminal spawn statuses — mirrors the private SPAWN_TERMINAL_STATUSES set
// in server/engine/v3-reconciler.ts.
const TERMINAL_SPAWN_STATUSES = new Set(["done", "failed", "cancelled"]);

/** Retry a node — reset to ready, reconciler will re-spawn. */
export const nodeRetry = defineAction({
  description: "Retry a V3 node. Resets node status to ready.",
  schema: z.object({
    runId: z.string(),
    nodeId: z.string(),
  }),
  run: async (args) => {
    const db = getV3Db();
    await assertRunAccess(db, args.runId);
    const rows = await db
      .select({
        id: v3Schema.v3Nodes.id,
        status: v3Schema.v3Nodes.status,
        currentSpawnId: v3Schema.v3Nodes.currentSpawnId,
      })
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
    const currentSpawnId = rows[0].currentSpawnId;

    let admitted = ["failed", "cancelled"].includes(prev);

    // R9 (docs/sdlc-product-design/02-workflows.md §4, SDLC-050) conduction
    // gap: a node NOT already terminal (e.g. still 'running') whose bound
    // spawn has ALREADY reached a terminal status is the exact B2 hung-node
    // shape — the reconciler's tick() conduction rule should normally have
    // already migrated it, but nodeRetry stays a defensive manual escape
    // hatch for the window before that happens. A genuinely healthy running
    // node (no spawn bound yet, or its spawn is still running/pending) is
    // still rejected below.
    if (!admitted && !TERMINAL_NODE_STATUSES.has(prev) && currentSpawnId) {
      const [spawn] = await db
        .select({ status: v3Schema.v3Spawns.status })
        .from(v3Schema.v3Spawns)
        .where(eq(v3Schema.v3Spawns.id, currentSpawnId))
        .limit(1);
      if (spawn && TERMINAL_SPAWN_STATUSES.has(spawn.status)) {
        admitted = true;
      }
    }

    if (!admitted) {
      throw new Error(
        `Node is ${prev}; can only retry failed or cancelled nodes, or a ` +
          `non-terminal node whose current spawn has already ended`,
      );
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
    await assertRunAccess(db, args.runId);
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

/**
 * Resolve a human_gate node.
 *
 * G31: accepts ANY string choice; validates it against the node's declared
 * `options` array from the DAG definition (not a hard-coded approve/reject enum).
 * Output shape: { choice, note } per design §4.4.
 */
export const nodeResolveGate = defineAction({
  description:
    "Resolve a V3 human_gate node. `choice` must be one of the options declared on the node in the DAG (e.g. 'approve', 'reject', 'modify'). Returns { choice, note }.",
  schema: z.object({
    runId: z.string(),
    nodeId: z.string(),
    /** One of the strings declared in the node's `options` array in the DAG. */
    choice: z.string().min(1),
    note: z.string().optional(),
  }),
  run: async (args) => {
    const db = getV3Db();
    await assertRunAccess(db, args.runId);

    // Load node row
    const rows = await db
      .select({
        id: v3Schema.v3Nodes.id,
        status: v3Schema.v3Nodes.status,
        nodeIdInDag: v3Schema.v3Nodes.nodeIdInDag,
      })
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

    // Load the DAG to find the node's declared options
    const runRows = await db
      .select({ dag: v3Schema.v3Runs.dag })
      .from(v3Schema.v3Runs)
      .where(eq(v3Schema.v3Runs.id, args.runId))
      .limit(1);

    if (!runRows.length) throw new Error(`Run '${args.runId}' not found`);

    // Find the DAG node definition to extract declared options
    const dag = runRows[0].dag as {
      nodes?: Array<{ id: string; type: string; options?: string[] }>;
    } | null;
    const dagNode = (dag?.nodes ?? []).find(
      (n) => n.id === rows[0].nodeIdInDag,
    );
    const declaredOptions: string[] | undefined = dagNode?.options;

    // Validate choice against declared options when the node has them
    if (declaredOptions && declaredOptions.length > 0) {
      if (!declaredOptions.includes(args.choice)) {
        throw new Error(
          `Invalid choice '${args.choice}'. Node '${rows[0].nodeIdInDag}' declares options: [${declaredOptions.join(", ")}]`,
        );
      }
    }

    // The node is "done" after resolution regardless of choice — downstream
    // nodes use {{deps.NODE.output.choice}} in their guards to branch.
    await db
      .update(v3Schema.v3Nodes)
      .set({ status: "done" as any, completedAt: new Date() })
      .where(eq(v3Schema.v3Nodes.id, args.nodeId));

    // Store resolution as artifact — output shape per design §4.4: { choice, note }
    const artifactId = crypto.randomUUID();
    const resolution = { choice: args.choice, note: args.note ?? null };

    await db.insert(v3Schema.v3Artifacts).values({
      id: artifactId,
      spawnId: "", // no spawn for human_gate resolutions
      kind: "human-gate-resolution",
      textContent: JSON.stringify(resolution),
      objectContent: resolution as any,
      byteSize: JSON.stringify(resolution).length,
      truncated: 0,
    });

    await db
      .update(v3Schema.v3Nodes)
      .set({ outputArtifactId: artifactId })
      .where(eq(v3Schema.v3Nodes.id, args.nodeId));

    return {
      nodeId: args.nodeId,
      choice: args.choice,
      note: args.note ?? null,
    };
  },
});
