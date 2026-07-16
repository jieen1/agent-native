// Pure logic for the /queue page (app/pages/QueuePage.tsx) — grouping,
// waitingOn/healthCheckLog parsing, sort order, and stats. Kept framework-free
// (no React) so it can be unit tested directly without a DOM. Mirrors the
// app/lib/inbox.ts convention for /inbox.
import type { QueueItem } from "@shared/types";

// ── Groups (03-tracker.md §8: 运行中 / 可派发 / 等待依赖 / 等待健康门) ────────

export type QueueGroupKey =
  | "running"
  | "dispatchable"
  | "dependency"
  | "health";

export const QUEUE_GROUP_ORDER: QueueGroupKey[] = [
  "running",
  "dispatchable",
  "dependency",
  "health",
];

export const QUEUE_GROUP_LABELS: Record<QueueGroupKey, string> = {
  running: "运行中",
  dispatchable: "可派发",
  dependency: "等待依赖",
  health: "等待健康门",
};

// ── waitingOn / healthCheckLog (v28 columns) ────────────────────────────────

export interface QueueWaitingOnDependency {
  type: "dependency";
  items: Array<{ id: string; itemKey: string }>;
}
export interface QueueWaitingOnHealth {
  type: "health";
  reason: string;
}
export type QueueWaitingOn =
  | QueueWaitingOnDependency
  | QueueWaitingOnHealth
  | Record<string, never>;

export function parseQueueWaitingOn(
  raw: string | null | undefined,
): QueueWaitingOn {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as QueueWaitingOn;
    }
    return {};
  } catch {
    return {};
  }
}

export interface QueueHealthLogEntry {
  reason: string;
  at: string;
}

export function parseQueueHealthLog(
  raw: string | null | undefined,
): QueueHealthLogEntry | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.reason === "string") {
      return parsed as QueueHealthLogEntry;
    }
    return null;
  } catch {
    return null;
  }
}

/** Legacy pre-v28 rows only ever wrote `blockedBy` (never `waitingOn`) —
 *  parse it the same defensive way for rows written before the migration. */
function legacyBlockedByItems(
  item: QueueItem,
): Array<{ id?: string; itemKey?: string }> {
  if (!item.blockedBy) return [];
  try {
    const parsed = JSON.parse(item.blockedBy);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ── Grouping ─────────────────────────────────────────────────────────────────

function isRunning(item: QueueItem): boolean {
  const w = item.workItem;
  return (
    w?.execState === "dispatched" ||
    w?.status === "running" ||
    w?.status === "dispatched"
  );
}

/** The only writer of a health-gate rejection (dispatch-to-orchestrator's
 *  scheduler-paused branch) never touches `status`, so a row can be
 *  `waitingOn.type==='health'` while `status` is still 'queued' — checked
 *  BEFORE the dependency/blocked check so a since-recovered, now-running item
 *  (execState flips to 'dispatched') always shows as running even if its
 *  stale exec_queue row still carries an old health rejection. */
export function queueGroupOf(item: QueueItem): QueueGroupKey {
  if (isRunning(item)) return "running";
  const waitingOn = parseQueueWaitingOn(item.waitingOn);
  if (waitingOn.type === "health") return "health";
  if (item.status === "blocked" || item.status === "等待依赖")
    return "dependency";
  return "dispatchable";
}

export function groupQueueItems(
  items: QueueItem[],
): Record<QueueGroupKey, QueueItem[]> {
  const groups: Record<QueueGroupKey, QueueItem[]> = {
    running: [],
    dispatchable: [],
    dependency: [],
    health: [],
  };
  for (const item of items) {
    groups[queueGroupOf(item)].push(item);
  }
  groups.dispatchable = sortDispatchable(groups.dispatchable);
  return groups;
}

/** Explicit `position` (set by reorder-queue, 1-based) sorts first and wins
 *  ties by index; rows never manually reordered fall back to priority desc /
 *  enqueuedAt asc, after every positioned row. `position <= 0` (covers both
 *  `null` on a fresh nullable column and the legacy `NOT NULL DEFAULT 0`
 *  shape some production rows carry — see schema.ts's execQueue docblock) is
 *  the "unordered" sentinel, which is why reorder-queue assigns 1-based
 *  positions rather than 0-based. */
export function sortDispatchable(items: QueueItem[]): QueueItem[] {
  const isPositioned = (it: QueueItem) => (it.position ?? 0) > 0;
  return [...items].sort((a, b) => {
    const aPositioned = isPositioned(a);
    const bPositioned = isPositioned(b);
    if (aPositioned && bPositioned) return a.position! - b.position!;
    if (aPositioned) return -1;
    if (bPositioned) return 1;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.enqueuedAt.localeCompare(b.enqueuedAt);
  });
}

/** Row-tail waiting badge text — null when the row isn't waiting on anything
 *  (the dispatchable/running groups). */
export function waitingLabel(item: QueueItem): string | null {
  const waitingOn = parseQueueWaitingOn(item.waitingOn);
  if (waitingOn.type === "dependency") {
    const keys = waitingOn.items.map((d) => d.itemKey).filter(Boolean);
    return keys.length ? `等待 ${keys.join("、")}` : "等待依赖";
  }
  if (waitingOn.type === "health") {
    return waitingOn.reason ? `不健康：${waitingOn.reason}` : "等待健康门恢复";
  }
  const legacy = legacyBlockedByItems(item);
  if (legacy.length > 0) {
    const keys = legacy.map((d) => d.itemKey).filter(Boolean);
    return keys.length ? `等待 ${keys.join("、")}` : "等待依赖";
  }
  return null;
}

// ── Stats cards (排队/运行中/等待依赖/等待健康门/今日完成/失败) ───────────────

export interface QueueStatsCard {
  queued: number;
  running: number;
  dependency: number;
  health: number;
  doneToday: number;
  failed: number;
}

export interface WorkItemStatusSlice {
  status: string;
  updatedAt?: string | null;
}

export function computeQueueStatsCards(
  groups: Record<QueueGroupKey, QueueItem[]>,
  allWorkItems: WorkItemStatusSlice[],
  now: Date = new Date(),
): QueueStatsCard {
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const doneToday = allWorkItems.filter((it) => {
    if (it.status !== "done") return false;
    const updatedAt = it.updatedAt ? new Date(it.updatedAt) : null;
    return !!updatedAt && updatedAt >= todayStart;
  }).length;
  const failed = allWorkItems.filter((it) => it.status === "failed").length;
  return {
    queued: groups.dispatchable.length,
    running: groups.running.length,
    dependency: groups.dependency.length,
    health: groups.health.length,
    doneToday,
    failed,
  };
}

// ── Reorder / pin-to-top helpers (frontend computes the full order, one
// reorder-queue call persists it — same contract as tasks' reorder-tasks) ───

export function moveIdToTop(ids: string[], id: string): string[] {
  const rest = ids.filter((x) => x !== id);
  return [id, ...rest];
}

export function moveIdBetween(
  ids: string[],
  activeId: string,
  overId: string,
): string[] {
  if (activeId === overId) return ids;
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from === -1 || to === -1) return ids;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, activeId);
  return next;
}
