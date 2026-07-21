// M5 度量复盘 — batched, adversarial-robust cross-app spawn fetch.
//
// The sprint cockpit's 实走验证 timing is derived from REAL orchestrator
// `v3_spawns` timestamps, read back over the SAME structured MCP `tools/call`
// channel get-activity.ts uses (spawnList + v3RunNodes). This module centralises
// that fetch so the two M5 read actions (get-sprint-stage-timing,
// get-sprint-status) share ONE disciplined implementation.
//
// ADVERSARIAL CONTRACT (M5 finding #4):
//  - BATCHED, NO N+1: spawns are fetched ONCE per distinct dispatching OWNER
//    (a single `spawnList { tagMatch: { source: "tracker" } }` call), then
//    grouped by work-item id client-side. We NEVER issue one spawnList call per
//    work item — a sprint with 40 items is still ≤ (#distinct owners) calls.
//  - DEGRADED HONEST EMPTY STATE: any spawnList error/timeout is swallowed into
//    `errors` and flips `degraded = true`; the caller renders all stages as
//    无数据 (no data) rather than throwing or fabricating numbers.
//  - BOUNDED: node resolution is per DISTINCT run (not per item, not per spawn),
//    capped, and best-effort — a node miss just leaves that spawn unstaged
//    (surfaces as 无数据, never a wrong number).

import { callOrchestratorTool } from "./orchestrator-client.js";
import type {
  NodeTimingRow,
  SpawnTimingRow,
} from "../../shared/sprint-timing.js";

/** Per-call timeout so a hung orchestrator can't wedge the cockpit forever. */
const SPAWN_FETCH_TIMEOUT_MS = 15_000;
/** Max spawns pulled per owner page (tracker-tagged only). */
const SPAWN_LIST_LIMIT = 500;
/** Max distinct runs we'll resolve nodes for (bounds the fan-out). */
const MAX_RUN_NODE_LOOKUPS = 50;

async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toSpawnRow(row: Record<string, unknown>): SpawnTimingRow {
  return {
    id: String(row.id ?? ""),
    nodeId: (row.nodeId as string | null) ?? null,
    runId: (row.runId as string | null) ?? null,
    status: String(row.status ?? ""),
    tags: row.tags,
    startedAt: (row.startedAt as string | null) ?? null,
    completedAt: (row.completedAt as string | null) ?? null,
  };
}

export interface SprintSpawnFetchResult {
  spawns: SpawnTimingRow[];
  nodes: NodeTimingRow[];
  /** True when ANY owner's spawnList failed/timed out — caller must render an
   *  honest empty state, never fabricate. */
  degraded: boolean;
  errors: Record<string, string>;
}

/**
 * Fetch every tracker-tagged spawn for a set of dispatching owners (ONE call
 * per owner), plus the DAG node rows needed to stage them. Never throws:
 * failures degrade to an honest empty result with `degraded = true`.
 *
 * @param owners distinct ownerEmails that dispatched this sprint's items
 *               (spawnList is owner-scoped on the orchestrator side, so we must
 *               call as the real dispatching owner — get-activity.ts's rule).
 */
export async function fetchSprintSpawnsBatched(
  owners: string[],
): Promise<SprintSpawnFetchResult> {
  const spawns: SpawnTimingRow[] = [];
  const errors: Record<string, string> = {};
  let degraded = false;

  const distinctOwners = [...new Set(owners.filter((o) => !!o))];

  // ── One spawnList call per distinct owner (BATCHED — no per-item N+1) ────
  await Promise.all(
    distinctOwners.map(async (owner) => {
      try {
        const { data } = await withTimeout(
          callOrchestratorTool(owner, "spawnList", {
            tagMatch: { source: "tracker" },
            limit: SPAWN_LIST_LIMIT,
          }),
          SPAWN_FETCH_TIMEOUT_MS,
          `spawnList(${owner})`,
        );
        if (Array.isArray(data)) {
          for (const row of data as Array<Record<string, unknown>>) {
            spawns.push(toSpawnRow(row));
          }
        }
      } catch (e) {
        degraded = true;
        errors[`spawns:${owner}`] = String((e as Error)?.message ?? e);
      }
    }),
  );

  // ── Resolve each spawn's node → DAG id, per DISTINCT run (bounded) ───────
  const runIds = [
    ...new Set(spawns.map((s) => s.runId).filter((r): r is string => !!r)),
  ].slice(0, MAX_RUN_NODE_LOOKUPS);

  const nodes: NodeTimingRow[] = [];
  await Promise.all(
    runIds.map(async (runId) => {
      // v3RunNodes is owner-scoped to the run's owner; try each owner until one
      // can read it. Best-effort — a miss leaves those nodes unstaged (surfaces
      // as 无数据, never a wrong number) and never flips `degraded`.
      for (const owner of distinctOwners) {
        try {
          const { data } = await withTimeout(
            callOrchestratorTool(owner, "v3RunNodes", { runId }),
            SPAWN_FETCH_TIMEOUT_MS,
            `v3RunNodes(${runId})`,
          );
          if (Array.isArray(data)) {
            for (const n of data as Array<Record<string, unknown>>) {
              nodes.push({
                id: String(n.id ?? ""),
                nodeIdInDag: (n.nodeIdInDag as string | null) ?? null,
              });
            }
            return;
          }
        } catch {
          // try next owner
        }
      }
    }),
  );

  return { spawns, nodes, degraded, errors };
}
