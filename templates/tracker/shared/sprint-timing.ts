// M5 度量复盘 — per-work-item stage timing derivation (pure, framework-free).
//
// Single source of truth for the Sprint 驾驶舱's "各环节耗时 / 实走验证 timing"
// panel (actions/get-sprint-stage-timing.ts + actions/get-sprint-status.ts →
// SprintDetailPage.tsx). Mirrors app/lib/sprint-metrics.ts's framework-free
// convention so it is unit-testable without a DOM.
//
// CRITICAL CONSTRAINT (M5 finding #1): every duration here is derived NATIVELY
// from REAL orchestrator `v3_spawns` timestamps — `started_at` / `completed_at`
// (the columns the orchestrator's `spawnList` MCP tool surfaces as `startedAt`
// / `completedAt`). We deliberately do NOT regex-mine Claude Code JSONL
// transcripts (~/.claude/projects/*.jsonl): that file format does not exist in
// this system (the V3 model records spawn lifecycle in Postgres `v3_spawns` /
// `spawn_events`, not in a per-project transcript dir). Reading the real
// columns is what keeps these numbers cross-checkable against the orchestrator.
//
// Honesty rule: a stage with NO spawn data reports `totalSec === null`
// ("无数据"), NEVER 0 and NEVER a fabricated number. A spawn that started but
// has not completed contributes `durationSec === null` (still running) — it is
// NOT counted in `totalSec` / `spawnCount` until it settles.

import type {
  SpawnTimingEvidence,
  StageTiming,
  TimingStage,
  WorkItemStageTiming,
} from "./types.js";

// ── Row shapes (only the fields timing derivation needs) ─────────────────────

/** A v3_nodes row as returned by the orchestrator's `v3RunNodes` MCP tool. */
export interface NodeTimingRow {
  /** v3_nodes.id */
  id: string;
  /** v3_nodes.node_id_in_dag — the DAG role name (e.g. "develop", "review1"). */
  nodeIdInDag: string | null;
}

/** A v3_spawns row as returned by the orchestrator's `spawnList` MCP tool. */
export interface SpawnTimingRow {
  /** v3_spawns.id */
  id: string;
  /** v3_nodes.id — links the spawn to its DAG node (null for ad-hoc spawns). */
  nodeId: string | null;
  /** v3_runs.id */
  runId: string | null;
  status: string;
  /** Raw tags column (JSONB object or JSON string) — tracker sets `item_id`. */
  tags: unknown;
  /** v3_spawns.started_at */
  startedAt: string | null;
  /** v3_spawns.completed_at */
  completedAt: string | null;
}

// ── Stage vocabulary ─────────────────────────────────────────────────────────

/** The four review-facing stages the panel reports, in pipeline order. */
export const TIMING_STAGES: readonly TimingStage[] = [
  "dev",
  "qa",
  "review",
  "gate",
];

export const TIMING_STAGE_LABELS: Record<TimingStage, string> = {
  dev: "开发 dev",
  qa: "测试 qa",
  review: "评审 review",
  gate: "门 gate",
};

// ── Core derivation functions ────────────────────────────────────────────────

/**
 * Classify a DAG node id to the review-facing timing stage it implements.
 *
 * The orchestrator's SDLC workflow DAGs name their nodes by role (see
 * orchestrator/server/engine/workflow-library-seed.ts):
 *   dev:    "dev", "develop", "devfix" (the vLLM coding node + fix rounds)
 *   qa:     "qa", "qa2" (test nodes)
 *   review: "review1", "reviewfix", "merge_review" (reviewer nodes + fixes)
 *   gate:   "gatestack", "gatetests" (gate/stack nodes)
 *
 * Nodes that don't map to a timing stage (e.g. "promote", "audit") return null
 * and are excluded from timing aggregation.
 */
export function classifyNodeStage(
  nodeIdInDag: string | null | undefined,
): TimingStage | null {
  if (!nodeIdInDag) return null;
  const id = nodeIdInDag.toLowerCase();
  if (id === "dev" || id === "develop" || id === "devfix") return "dev";
  if (id === "qa" || id === "qa2") return "qa";
  if (id === "review1" || id === "reviewfix" || id === "merge_review")
    return "review";
  if (id === "gatestack" || id === "gatetests") return "gate";
  return null;
}

/**
 * Extract the tracker work-item id from a raw spawn's tags column.
 * Tags may arrive as a JSONB object or a JSON string. Returns null when absent
 * or malformed — never guesses.
 */
export function spawnItemId(tags: unknown): string | null {
  if (!tags) return null;
  try {
    const obj: unknown = typeof tags === "string" ? JSON.parse(tags) : tags;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    const v = (obj as Record<string, unknown>).item_id;
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * Duration in seconds from startedAt/completedAt, or null if either timestamp
 * is missing/unparseable or the interval is negative (clock skew → treat as no
 * honest data rather than a fabricated negative number).
 */
export function durationSec(
  startedAt: string | null,
  completedAt: string | null,
): number | null {
  if (!startedAt || !completedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(completedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const diff = (end - start) / 1000;
  return diff >= 0 ? diff : null;
}

/**
 * Derive per-work-item stage timings from raw orchestrator data.
 *
 * BATCHED CONTRACT (M5 finding #4): the caller fetches spawns ONCE (a single
 * `spawnList` call per distinct dispatching owner) and passes the whole set
 * here; this function groups them by work-item id in one pass — there is NO
 * per-work-item fetch (no N+1). `nodes` is the union of every relevant run's
 * node rows, used to resolve each spawn's `nodeId` → `nodeIdInDag` DAG role.
 *
 * @param spawns      - All v3_spawns rows for this sprint's owners (spawnList,
 *                      already filtered by `tagMatch: { source: "tracker" }`).
 * @param nodes       - All v3_nodes rows for the relevant runs (v3RunNodes).
 * @param workItemIds - The tracker work-item ids to compute timings for.
 * @param itemMeta    - Optional itemKey/title lookup (falls back to the id).
 *
 * Returns one `WorkItemStageTiming` per work-item id (in input order). Items
 * with no matching spawns still appear, with all four stages as `无数据`
 * (totalSec=null) — an honest empty state, never a fabricated 0.
 */
export function deriveWorkItemTimings(
  spawns: SpawnTimingRow[],
  nodes: NodeTimingRow[],
  workItemIds: string[],
  itemMeta?: Map<string, { itemKey: string; title: string }>,
): WorkItemStageTiming[] {
  const nodeMap = new Map<string, NodeTimingRow>(nodes.map((n) => [n.id, n]));

  // Group spawns by work-item id (extracted from tags) in ONE pass.
  const byItem = new Map<string, SpawnTimingRow[]>();
  for (const id of workItemIds) byItem.set(id, []);
  for (const spawn of spawns) {
    const itemId = spawnItemId(spawn.tags);
    if (!itemId || !byItem.has(itemId)) continue;
    byItem.get(itemId)!.push(spawn);
  }

  return workItemIds.map((workItemId) => {
    const itemSpawns = byItem.get(workItemId) ?? [];
    const meta = itemMeta?.get(workItemId);

    const buckets = new Map<TimingStage, SpawnTimingEvidence[]>();
    for (const stage of TIMING_STAGES) buckets.set(stage, []);

    for (const spawn of itemSpawns) {
      const node = spawn.nodeId ? nodeMap.get(spawn.nodeId) : null;
      const nodeIdInDag = node?.nodeIdInDag ?? null;
      const stage = classifyNodeStage(nodeIdInDag);
      if (!stage) continue;

      const sec = durationSec(spawn.startedAt, spawn.completedAt);
      buckets.get(stage)!.push({
        spawnId: spawn.id,
        runId: spawn.runId ?? null,
        nodeIdInDag: nodeIdInDag ?? null,
        status: spawn.status ?? "",
        startedAt: spawn.startedAt ?? null,
        completedAt: spawn.completedAt ?? null,
        durationSec: sec,
      });
    }

    const stages: StageTiming[] = TIMING_STAGES.map((stage) => {
      const evidence = buckets.get(stage)!;
      let totalSec: number | null = null;
      let spawnCount = 0;
      let sum = 0;
      for (const s of evidence) {
        if (s.durationSec != null) {
          sum += s.durationSec;
          spawnCount++;
        }
      }
      // Only report a total when at least one spawn actually settled; an
      // all-running / empty bucket stays null (honest "无数据").
      totalSec = spawnCount > 0 ? sum : null;
      return { stage, totalSec, spawnCount, spawns: evidence };
    });

    return {
      workItemId,
      itemKey: meta?.itemKey ?? workItemId,
      title: meta?.title ?? workItemId,
      stages,
    };
  });
}

/** Human-friendly render of a seconds value (e.g. "1h05m", "3m20s", "45s"). */
export function formatDurationSec(sec: number | null): string {
  if (sec == null) return "无数据";
  const total = Math.round(sec);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return s > 0 ? `${m}m${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm > 0 ? `${h}h${String(mm).padStart(2, "0")}m` : `${h}h`;
}
