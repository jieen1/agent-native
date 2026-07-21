// M5 度量复盘 — per-work-item stage timing derivation (pure, framework-free).
//
// This is the single source of truth for the Sprint 驾驶舱's "各环节耗时"
// panel (actions/get-sprint-stage-timing.ts → SprintDetailPage.tsx UI).
//
// CRITICAL CONSTRAINT (M5): every duration here is derived NATIVELY from real
// orchestrator `v3_spawns` timestamps — `started_at` / `completed_at` (the
// columns the orchestrator's `spawnList` action surfaces as `startedAt` /
// `completedAt`). We deliberately do NOT regex-mine Claude Code JSONL
// transcripts: that file format does not exist in this system (the v3 model
// records spawn lifecycle in Postgres, not in a per-project transcript dir).
// Reading the real columns is what keeps the numbers cross-checkable against
// the orchestrator's runs page.
//
// Honesty rule: a stage with NO spawn data reports `totalSec === null`
// ("no data"), NEVER 0 and NEVER a fabricated number. A spawn that started but
// has not completed contributes `durationSec === null` (still running) — it is
// NOT counted in `totalSec` or `spawnCount` until it settles.

import type {
  SpawnTimingEvidence,
  StageTiming,
  TimingStage,
  WorkItemStageTiming,
} from "./types.js";

// ── Types used by the action (get-sprint-stage-timing.ts) and the test ────────

/** A v3_nodes row (only the fields timing derivation needs). */
export interface NodeTimingRow {
  /** v3_nodes.id */
  id: string;
  /** v3_nodes.node_id_in_dag */
  nodeIdInDag: string | null;
}

/** A v3_spawns row as returned by the orchestrator's `spawnList` MCP tool. */
export interface SpawnTimingRow {
  /** v3_spawns.id */
  id: string;
  /** v3_nodes.id — links the spawn to its DAG node (null for ad-hoc). */
  nodeId: string | null;
  /** v3_runs.id */
  runId: string | null;
  status: string;
  /** Raw tags column (JSONB or JSON string) — tracker sets `item_id` here. */
  tags: unknown;
  /** v3_spawns.started_at */
  startedAt: string | null;
  /** v3_spawns.completed_at */
  completedAt: string | null;
}

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

// ── Core derivation functions ─────────────────────────────────────────────────

/**
 * Classify a DAG node id to the review-facing timing stage it implements.
 *
 * The orchestrator's SDLC workflow DAGs name their nodes by role (see
 * orchestrator/server/engine/workflow-library-seed.ts):
 *   dev:    "dev", "develop", "devFix" (the vLLM coding node + fix rounds)
 *   qa:     "qa", "qa2" (test nodes)
 *   review: "review1", "reviewfix", "merge_review" (reviewer nodes + fix rounds)
 *   gate:   "gateStack", "gateTests" (gate/stack nodes)
 *
 * Nodes that don't map to a timing stage (e.g. "promote", "audit") return null
 * and are excluded from timing aggregation.
 */
export function classifyNodeStage(
  nodeIdInDag: string | null | undefined,
): TimingStage | null {
  if (!nodeIdInDag) return null;
  const id = nodeIdInDag.toLowerCase();

  // dev: "dev", "develop", "devfix"
  if (id === "dev" || id === "develop" || id === "devfix") return "dev";
  // qa: "qa", "qa2"
  if (id === "qa" || id === "qa2") return "qa";
  // review: "review1", "reviewfix", "merge_review"
  if (id === "review1" || id === "reviewfix" || id === "merge_review") return "review";
  // gate: "gatestack", "gatetests"
  if (id === "gatestack" || id === "gatetests") return "gate";

  return null;
}

/**
 * Extract the tracker work-item id from a raw spawn's tags column.
 * Tags may arrive as a JSONB object or as a JSON string.
 * Returns null when absent or malformed — never guesses.
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
 * Compute duration in seconds from startedAt/completedAt.
 * Returns null if either timestamp is missing or unparseable.
 */
function durationSec(
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
 * @param spawns - All v3_spawns rows for this sprint (from spawnList, already
 *   filtered by `tagMatch: { source: "tracker" }`).
 * @param nodes  - All v3_nodes rows for the relevant runs (from v3RunNodes),
 *   used to resolve each spawn's `nodeId` → `nodeIdInDag` DAG role.
 * @param workItemIds - The tracker work-item ids to compute timings for.
 *
 * Returns one `WorkItemStageTiming` per work-item id (in input order). Items
 * with no matching spawns still appear, with all four stages as `no data`.
 */
export function deriveWorkItemTimings(
  spawns: SpawnTimingRow[],
  nodes: NodeTimingRow[],
  workItemIds: string[],
): WorkItemStageTiming[] {
  const nodeMap = new Map<string, NodeTimingRow>(nodes.map((n) => [n.id, n]));

  // Group spawns by work-item id (extracted from tags).
  const byItem = new Map<string, SpawnTimingRow[]>();
  for (const id of workItemIds) byItem.set(id, []);
  for (const spawn of spawns) {
    const itemId = spawnItemId(spawn.tags);
    if (!itemId || !byItem.has(itemId)) continue;
    byItem.get(itemId)!.push(spawn);
  }

  return workItemIds.map((workItemId) => {
    const itemSpawns = byItem.get(workItemId) ?? [];

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
      if (evidence.length > 0) {
        let sum = 0;
        let any = false;
        for (const s of evidence) {
          if (s.durationSec != null) {
            sum += s.durationSec;
            any = true;
            spawnCount++;
          }
        }
        totalSec = any ? sum : null;
      }
      return { stage, totalSec, spawnCount, spawns: evidence };
    });

    return { workItemId, itemKey: workItemId, title: workItemId, stages };
  });
}

/** Human-friendly render of a seconds value (e.g. "1h 05m", "3m 20s", "45s"). */
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
