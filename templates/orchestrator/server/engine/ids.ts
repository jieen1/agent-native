// Deterministic id derivation (DESIGN §1.7 / §4.2). NodeRun ids, thread ids and
// per-node run ids are derived ONLY from (runId, nodeId, iteration, fanoutIndex)
// — NEVER from Math.random / Date.now — so a replayed prefix produces identical
// ids and resume/journal keys are stable.

import type { NodeRunKey } from "./types.js";

/**
 * The DB id for a NodeRun. Deterministic in the journal key so re-running the
 * same logical node yields the same row id (the UNIQUE journal index in
 * node_runs enforces uniqueness on the same tuple).
 */
export function nodeRunId(runId: string, key: NodeRunKey): string {
  return `nr_${runId}_${key.nodeId}_${key.iteration}_${key.fanoutIndex}`;
}

/**
 * The per-NodeRun unique runId handed to `startRun` (DESIGN §4.2 landmine 1):
 * format `an-<runId>-<nodeId>-<iter>-<idx>`. Each concurrent NodeRun gets its
 * OWN unique runId so sibling background runs do not abort each other.
 */
export function nodeBackgroundRunId(runId: string, key: NodeRunKey): string {
  return `an-${runId}-${key.nodeId}-${key.iteration}-${key.fanoutIndex}`;
}

/**
 * The per-NodeRun thread id (DESIGN §4.2 landmine 1): one `createThread` per
 * NodeRun. Sharing a thread aborts siblings (run-manager.ts:222-226), so this
 * is also derived per journal key.
 */
export function nodeThreadId(runId: string, key: NodeRunKey): string {
  return `th-${runId}-${key.nodeId}-${key.iteration}-${key.fanoutIndex}`;
}

/** Deterministic artifact id for a node's output. */
export function outputArtifactId(runId: string, key: NodeRunKey): string {
  return `art_out_${runId}_${key.nodeId}_${key.iteration}_${key.fanoutIndex}`;
}

/** Deterministic artifact id for a node's resolved input snapshot. */
export function inputArtifactId(runId: string, key: NodeRunKey): string {
  return `art_in_${runId}_${key.nodeId}_${key.iteration}_${key.fanoutIndex}`;
}

/**
 * Deterministic artifact id for a loop accumulator keyed by
 * (runId, loopNodeId, iteration) — DESIGN §3.2 journaled accumulator.
 */
export function loopAccumulatorId(
  runId: string,
  loopNodeId: string,
  iteration: number,
): string {
  return `art_acc_${runId}_${loopNodeId}_${iteration}`;
}
