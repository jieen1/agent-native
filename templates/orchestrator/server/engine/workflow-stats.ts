/**
 * Pure helpers backing the S8 workflow library page (04-orchestrator.md §4):
 * run-count/success-rate aggregation for the card grid + version chain, and a
 * structural node diff for `workflowDiff`. Kept DB-free and pure so they're
 * directly unit-testable without mocking Drizzle's query builder — the
 * actions that call these do only the (thin) row fetch.
 */

export interface RunStatusRow {
  status: string;
}

export interface WorkflowRunStats {
  /** Count of runs in the queried window/scope, any status. */
  runCount: number;
  /**
   * Percentage (0-100) of TERMINAL runs (done/failed/cancelled) that finished
   * `done`. `null` when there are no terminal runs yet — still-pending/running
   * runs never count against or for the rate.
   */
  successRate: number | null;
}

const TERMINAL_STATUSES = new Set(["done", "failed", "cancelled"]);

export function computeRunStats(rows: RunStatusRow[]): WorkflowRunStats {
  const terminal = rows.filter((r) => TERMINAL_STATUSES.has(r.status));
  const successRate =
    terminal.length === 0
      ? null
      : Math.round(
          (terminal.filter((r) => r.status === "done").length /
            terminal.length) *
            100,
        );
  return { runCount: rows.length, successRate };
}

export interface DagNodeLike {
  id: string;
  [key: string]: unknown;
}

export interface DagNodeDiff {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: string[];
}

/**
 * Structural diff between two DAG node arrays, by node id. `changed` uses a
 * JSON.stringify equality check (best-effort content compare, not a canonical
 * deep-equal) — sufficient to flag "this node's definition moved between
 * versions" for the version-chain UI without pulling in a diff library for a
 * modest, already-JSON-shaped payload.
 */
export function diffDagNodes(
  before: DagNodeLike[],
  after: DagNodeLike[],
): DagNodeDiff {
  const mapBefore = new Map(before.map((n) => [n.id, n]));
  const mapAfter = new Map(after.map((n) => [n.id, n]));

  const added = [...mapAfter.keys()].filter((id) => !mapBefore.has(id));
  const removed = [...mapBefore.keys()].filter((id) => !mapAfter.has(id));
  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const [id, beforeNode] of mapBefore) {
    const afterNode = mapAfter.get(id);
    if (!afterNode) continue;
    const same = JSON.stringify(beforeNode) === JSON.stringify(afterNode);
    (same ? unchanged : changed).push(id);
  }

  return { added, removed, changed, unchanged };
}
