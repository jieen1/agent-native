// R4a.3 §4.2 point 7 — claude-code WORKER NODE admission gate.
//
// Unlike brain-admit.ts (which manages a dedicated `brain_tasks` queue table
// decoupled from thread status, because brain-send has many concurrent entry
// points), a DAG node's `v3_nodes.status` row IS already the ground truth of
// "is this occupying a slot right now" — the reconciler's existing atomic
// per-row CAS (`UPDATE v3_nodes SET status='running' WHERE status IN
// ('pending','ready')`, in v3-reconciler.ts's dispatchNode) already prevents
// double-claiming a single node. This module only needs to COUNT how many
// currently-running agent nodes, across ALL runs, resolve to the
// claude-code runtime (dag-validator.ts's `nodeTargetsClaudeCode`) and
// compare against the configured degree — no separate queue/release
// bookkeeping is needed: a slot frees itself automatically the instant a
// node's status leaves 'running' (done/failed), since the next count picks
// that up live.
//
// Trade-off (documented, not hidden): this is a best-effort PEEK check, not a
// transactionally-locked claim like brain-admit's advisory-lock section. A
// narrow race window exists between "count running < limit" and the
// reconciler's own atomic claim UPDATE immediately after (two concurrent
// ticks on DIFFERENT runs could both peek under the limit and both proceed).
// This is acceptable because (a) the design frames this gate as resource
// PROTECTION, not a security boundary ("这是资源保护，不是权限放宽"), (b) the
// per-run reconciler tick loop is not as highly-concurrent an entry point as
// brain-send (called from many places), and (c) a transient overshoot of one
// or two nodes past a soft default of 1 is a far smaller blast radius than
// the unlimited-concurrency gap this closes.

import { isPostgres } from "@agent-native/core/db";

import { getDbExec } from "../db/index.js";
import { nodeTargetsClaudeCode } from "../engine/dag-validator.js";
import { getClaudeCodeNodeConcurrency } from "./claude-code-concurrency.js";

/** One currently-running agent-type v3_nodes row, joined to its run's dag. */
export interface RunningAgentNodeRow {
  nodeIdInDag: string;
  /** The run's `dag` column — typically already a parsed object (jsonb), but
   *  accepted as a JSON string too for defensiveness (mirrors validateDag's
   *  own tolerance of a stringified dag). */
  dag: unknown;
}

/** Pure: given already-fetched running-agent-node rows (each carrying its
 *  run's dag), count how many resolve to the claude-code runtime. Testable
 *  without a database — the DB-backed wrapper below just fetches these rows. */
export function countClaudeCodeNodesFromRows(
  rows: RunningAgentNodeRow[],
): number {
  let n = 0;
  for (const row of rows) {
    let dag: unknown = row.dag;
    if (typeof dag === "string") {
      try {
        dag = JSON.parse(dag);
      } catch {
        continue;
      }
    }
    const nodes = (dag as { nodes?: unknown[] } | null)?.nodes;
    if (!Array.isArray(nodes)) continue;
    const match = nodes.find(
      (nd) => (nd as { id?: string })?.id === row.nodeIdInDag,
    ) as { agent?: string; engine_override?: string } | undefined;
    if (match && nodeTargetsClaudeCode(match)) n++;
  }
  return n;
}

/** Pure: true when admitting one more claude-code node keeps the running
 *  count within the configured limit. */
export function canAdmitClaudeCodeNode(
  currentlyRunning: number,
  limit: number,
): boolean {
  return currentlyRunning < limit;
}

/**
 * Count how many currently-running (`status='running'`, `type='agent'`)
 * v3_nodes, across ALL runs, resolve to the claude-code runtime. Uses
 * `getDbExec()` (the SAME raw-SQL accessor v3-reconciler.ts's dispatchNode
 * already uses for its atomic per-row claim) rather than a drizzle-typed
 * `db` instance, so it composes with the reconciler's existing query surface
 * without adding a second DB-access convention to that file.
 */
export async function countRunningClaudeCodeNodes(): Promise<number> {
  if (!isPostgres()) return 0;
  const res = await getDbExec().execute(`
    SELECT n.node_id_in_dag AS "nodeIdInDag", r.dag AS dag
    FROM v3_nodes n
    JOIN v3_runs r ON r.id = n.run_id
    WHERE n.status = 'running' AND n.type = 'agent'
  `);
  return countClaudeCodeNodesFromRows(
    res.rows as unknown as RunningAgentNodeRow[],
  );
}

export interface ClaudeCodeAdmission {
  admitted: boolean;
  running: number;
  limit: number;
}

/**
 * Admission check to call BEFORE claiming/spawning a claude-code-targeting
 * agent node. Non-Postgres (local SQLite dev) always admits — the gate can't
 * be enforced there and dev workflows must not hang waiting on a limit that
 * can never be counted.
 */
export async function admitClaudeCodeNode(): Promise<ClaudeCodeAdmission> {
  const limit = await getClaudeCodeNodeConcurrency();
  if (!isPostgres()) {
    return { admitted: true, running: 0, limit };
  }
  const running = await countRunningClaudeCodeNodes();
  return { admitted: canAdmitClaudeCodeNode(running, limit), running, limit };
}
