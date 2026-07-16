// Pure logic for the /inbox page (app/pages/InboxPage.tsx) — grouping order,
// selection resolution, relative time, and per-row action availability. Kept
// framework-free (no React) so it can be unit tested directly without a DOM.
import {
  STAGE_ORDER,
  type InboxCounts,
  type InboxGroupKey,
  type InboxGroups,
  type InboxRow,
} from "@shared/types";

/** Render order for the left-column groups — matches
 *  docs/sdlc-product-design/03-tracker.md §2: 签核 → 评审请求 → 裁决 → 失败路由 → 通知. */
export const INBOX_GROUP_ORDER: InboxGroupKey[] = [
  "signoff",
  "reviewRequest",
  "escalation",
  "failedRouting",
  "notifications",
];

export const INBOX_GROUP_LABELS: Record<InboxGroupKey, string> = {
  signoff: "签核",
  reviewRequest: "评审请求",
  escalation: "裁决",
  failedRouting: "失败路由",
  notifications: "通知",
};

const EMPTY_GROUPS: InboxGroups = {
  signoff: [],
  escalation: [],
  reviewRequest: [],
  failedRouting: [],
  notifications: [],
};

/** Flatten groups into one list, in the fixed group render order, preserving
 *  each group's own (newest-first) row order. */
export function flattenInboxRows(groups: InboxGroups | undefined): InboxRow[] {
  const g = groups ?? EMPTY_GROUPS;
  return INBOX_GROUP_ORDER.flatMap((key) => g[key] ?? []);
}

/** Resolve the row the detail panel should show for a given selected id —
 *  null when nothing is selected or the id no longer exists in any group
 *  (e.g. it was just resolved and the list refetched it away). */
export function findInboxRow(
  groups: InboxGroups | undefined,
  selectedId: string | null | undefined,
): InboxRow | null {
  if (!selectedId) return null;
  return flattenInboxRows(groups).find((r) => r.id === selectedId) ?? null;
}

/** First row across all groups, in render order — the initial detail-panel
 *  selection when the page loads with nothing selected. */
export function pickDefaultSelection(
  groups: InboxGroups | undefined,
): InboxRow | null {
  const rows = flattenInboxRows(groups);
  return rows[0] ?? null;
}

export function isGroupEmpty(
  groups: InboxGroups | undefined,
  key: InboxGroupKey,
): boolean {
  const g = groups ?? EMPTY_GROUPS;
  return (g[key] ?? []).length === 0;
}

/** Whether the whole inbox has nothing needing attention. */
export function isInboxEmpty(groups: InboxGroups | undefined): boolean {
  return flattenInboxRows(groups).length === 0;
}

/** request-approval requires a sprintId — a failed-routing item created
 *  outside a sprint has none, so "升级" has no real action to call for it.
 *  Never show the button in that case (no fake buttons). */
export function canEscalate(row: InboxRow): boolean {
  return row.group === "failedRouting" && !!row.sprintId;
}

/** Sidebar nav badge text — caps large counts so the pill stays compact. */
export function formatBadgeCount(n: number): string {
  if (n <= 0) return "";
  return n > 99 ? "99+" : String(n);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Coarse Chinese relative-time label. Falls back to a YYYY-MM-DD date once
 *  the gap is a week or more (matches fmtTime's precision elsewhere in this
 *  app for anything not "recent"). Never throws on a bad/missing timestamp. */
export function formatRelativeTime(
  iso: string | null | undefined,
  now: Date = new Date(),
): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = now.getTime() - then;
  if (diff < 0) return "刚刚";
  if (diff < MINUTE_MS) return "刚刚";
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)} 分钟前`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)} 小时前`;
  if (diff < 7 * DAY_MS) return `${Math.floor(diff / DAY_MS)} 天前`;
  const d = new Date(then);
  return d.toISOString().slice(0, 10);
}

/** The stage immediately before `currentStageName` in the 7-stage ladder, for
 *  the failed-routing "回退" action — mirrors the same STAGE_ORDER lookup
 *  WorkItemDetailPage's rollback button already uses. Null when the item is
 *  already at 待办 or the stage name isn't recognized (nothing to roll back
 *  to — never guess a target). */
export function previousStage(
  currentStageName: string | null | undefined,
): string | null {
  if (!currentStageName) return null;
  const idx = STAGE_ORDER.indexOf(
    currentStageName as (typeof STAGE_ORDER)[number],
  );
  if (idx <= 0) return null;
  return STAGE_ORDER[idx - 1] ?? null;
}

/** Total across every real (non-empty-placeholder) group — counts.total from
 *  list-inbox already excludes notifications, so this is a thin passthrough
 *  kept for a single call site in the sidebar badge. */
export function totalPendingCount(counts: InboxCounts | undefined): number {
  return counts?.total ?? 0;
}
