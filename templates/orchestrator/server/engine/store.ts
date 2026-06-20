// Journal + artifact persistence (DESIGN §1.7). All node_runs / artifacts DB
// I/O lives here so the scheduler talks to a small interface. Every NodeRun is
// persisted keyed by (run_id,node_id,iteration,fanout_index) — the UNIQUE
// journal index in node_runs enforces that identity.
//
// Artifact storage (P1 resolution, see header of engine/README): the produced
// output is stored INLINE as JSON in `artifacts.ref`. The `ref` column is TEXT
// and the artifact id is deterministic, so outputs are id-addressable today.
// P2 can repoint `ref` at the Resources store without changing this seam.

import { and, eq } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";
import { nowIso } from "../../actions/_util.js";
import {
  inputArtifactId,
  loopAccumulatorId,
  nodeRunId,
  outputArtifactId,
} from "./ids.js";
import type { NodeRunKey, NodeRunState } from "./types.js";

type Db = ReturnType<typeof getDb>;

/** Persist a freshly-created NodeRun row (status defaults to pending/ready). */
export async function insertNodeRun(
  db: Db,
  state: NodeRunState,
): Promise<void> {
  await db.insert(schema.nodeRuns).values({
    id: state.id,
    runId: state.runId,
    nodeId: state.key.nodeId,
    type: state.node.type,
    title: state.node.title ?? state.key.nodeId,
    assignee: state.node.assignee ?? null,
    engine: state.node.engine ?? null,
    model: state.node.model ?? null,
    status: state.status,
    iteration: state.key.iteration,
    fanoutIndex: state.key.fanoutIndex,
    dynamic: state.dynamic ? 1 : 0,
    inputRef: state.inputRef,
    outputRef: state.outputRef,
    error: state.error,
    agentRunId: state.id, // background runId is derived; stored for observability
    attempts: state.attempts,
    tokensSpent: state.tokensSpent,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
  });
}

/** Patch a NodeRun row with the mutable fields the scheduler changes. */
export async function updateNodeRun(
  db: Db,
  state: NodeRunState,
): Promise<void> {
  await db
    .update(schema.nodeRuns)
    .set({
      status: state.status,
      dynamic: state.dynamic ? 1 : 0,
      inputRef: state.inputRef,
      outputRef: state.outputRef,
      error: state.error,
      attempts: state.attempts,
      tokensSpent: state.tokensSpent,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
    })
    .where(eq(schema.nodeRuns.id, state.id));
}

/** Write an artifact row whose `ref` holds the inline JSON value (P1). */
export async function putArtifact(
  db: Db,
  args: {
    id: string;
    runId: string;
    nodeRunId: string | null;
    kind: string;
    value: unknown;
    summary?: string | null;
  },
): Promise<string> {
  const ref = JSON.stringify(args.value ?? null);
  // Deterministic id: upsert-safe insert (ignore if it already exists, e.g.
  // a replayed prefix re-deriving the same artifact id).
  const existing = await db
    .select({ id: schema.artifacts.id })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, args.id))
    .limit(1);
  if (existing.length > 0) {
    await db
      .update(schema.artifacts)
      .set({ ref, summary: args.summary ?? null })
      .where(eq(schema.artifacts.id, args.id));
    return args.id;
  }
  await db.insert(schema.artifacts).values({
    id: args.id,
    runId: args.runId,
    nodeRunId: args.nodeRunId,
    kind: args.kind,
    ref,
    summary: args.summary ?? null,
    createdAt: nowIso(),
  });
  return args.id;
}

/** Read an artifact's inline value back, or undefined if missing. */
export async function getArtifactValue(
  db: Db,
  id: string,
): Promise<unknown> {
  const rows = await db
    .select({ ref: schema.artifacts.ref })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.id, id))
    .limit(1);
  if (rows.length === 0) return undefined;
  try {
    return JSON.parse(rows[0].ref);
  } catch {
    return rows[0].ref;
  }
}

/** Store a node's output as a deterministic artifact, return its id. */
export async function putOutputArtifact(
  db: Db,
  runId: string,
  state: NodeRunState,
  value: unknown,
): Promise<string> {
  const id = outputArtifactId(runId, state.key);
  return putArtifact(db, {
    id,
    runId,
    nodeRunId: state.id,
    kind: "node-output",
    value,
  });
}

/** Store a node's resolved input snapshot as a deterministic artifact. */
export async function putInputArtifact(
  db: Db,
  runId: string,
  state: NodeRunState,
  value: unknown,
): Promise<string> {
  const id = inputArtifactId(runId, state.key);
  return putArtifact(db, {
    id,
    runId,
    nodeRunId: state.id,
    kind: "node-input",
    value,
  });
}

/** Read a loop accumulator artifact's value (the `seen` set + state). */
export async function getLoopAccumulator(
  db: Db,
  runId: string,
  loopNodeId: string,
  iteration: number,
): Promise<{ seen: string[]; dryRounds: number } | undefined> {
  const id = loopAccumulatorId(runId, loopNodeId, iteration);
  const v = await getArtifactValue(db, id);
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    return {
      seen: Array.isArray(obj.seen) ? (obj.seen as string[]) : [],
      dryRounds: typeof obj.dryRounds === "number" ? obj.dryRounds : 0,
    };
  }
  return undefined;
}

/** Write a loop accumulator artifact keyed by (runId, loopNodeId, iteration). */
export async function putLoopAccumulator(
  db: Db,
  runId: string,
  loopNodeId: string,
  iteration: number,
  value: { seen: string[]; dryRounds: number },
): Promise<string> {
  const id = loopAccumulatorId(runId, loopNodeId, iteration);
  return putArtifact(db, {
    id,
    runId,
    nodeRunId: null,
    kind: "loop-accumulator",
    value,
  });
}

/** Load every persisted NodeRun row for a run (for resume / observation). */
export async function loadNodeRuns(db: Db, runId: string) {
  return db
    .select()
    .from(schema.nodeRuns)
    .where(eq(schema.nodeRuns.runId, runId));
}

/** Load a single NodeRun by its journal key, or undefined. */
export async function loadNodeRunByKey(
  db: Db,
  runId: string,
  key: NodeRunKey,
) {
  const id = nodeRunId(runId, key);
  const rows = await db
    .select()
    .from(schema.nodeRuns)
    .where(and(eq(schema.nodeRuns.runId, runId), eq(schema.nodeRuns.id, id)))
    .limit(1);
  return rows[0];
}

export type { Db };
