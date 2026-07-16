// Pure logic for the /inbox page (app/pages/InboxPage.tsx) — grouping order,
// selection resolution, relative time, and per-row action availability. Kept
// framework-free (no React) so it can be unit tested directly without a DOM.
import {
  STAGE_ORDER,
  type Approval,
  type Artifact,
  type InboxCounts,
  type InboxGroupKey,
  type InboxGroups,
  type InboxRow,
  type SprintArtifact,
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

// ── Pending / processed tab (S5) ─────────────────────────────────────────────

export type InboxTab = "pending" | "processed";

/** "已处理" data source — decided (approved/rejected) approvals only. No
 *  separate action exists for this (nor is one needed): list-approvals
 *  already returns every status when called without a `status` filter, so
 *  this is a client-side filter, not a new query. */
export function processedApprovals(
  approvals: Approval[] | undefined,
): Approval[] {
  return (approvals ?? []).filter((a) => a.status !== "pending");
}

// ── Escalation run resolution (S5 裁决卡 "run关联徽标") ───────────────────────

/** Safely parse an approval's `gateRef` — an optional JSON
 *  `{runId, nodeId}` blob (see actions/request-approval.ts). Never throws on
 *  malformed/missing input. */
export function parseGateRef(
  gateRef: string | null | undefined,
): { runId?: string; nodeId?: string } | null {
  if (!gateRef) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(gateRef);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const runId = (parsed as Record<string, unknown>).runId;
  const nodeId = (parsed as Record<string, unknown>).nodeId;
  const result: { runId?: string; nodeId?: string } = {};
  if (typeof runId === "string" && runId) result.runId = runId;
  if (typeof nodeId === "string" && nodeId) result.nodeId = nodeId;
  return result.runId || result.nodeId ? result : null;
}

/** The run id to badge/link on an escalation card: the gate's own `gateRef`
 *  when present (the precise run it blocks), else the item's most recent
 *  `get-activity` run — same fallback FailedRoutingDetail's evidence already
 *  uses, never guessing beyond what either source reports. */
export function resolveEscalationRunId(
  gateRef: string | null | undefined,
  activityRuns: Array<{ id: string }> | undefined,
): string | null {
  const parsed = parseGateRef(gateRef);
  if (parsed?.runId) return parsed.runId;
  return activityRuns?.[0]?.id ?? null;
}

// ── Gate approval guard (S5 门判据 → 批准按钮禁用) ────────────────────────────

export interface ApproveGateGuard {
  /** Whether this row has a workItemId — the F6 checklist is assembled per
   *  work item, so a sprint-scoped signoff with no item (`workItemId` left
   *  blank in request-approval) has no checklist to gate on. */
  hasWorkItem: boolean;
  checklistLoading: boolean;
  /** null when no checklist applies (hasWorkItem is false, or it hasn't
   *  loaded yet without being in a loading state — treated as ungated). */
  checklistComplete: boolean | null;
}

/** Whether the Approve button should be disabled. Only gates when a real
 *  per-item checklist exists to gate on — never fabricates a criterion for a
 *  sprint-level signoff the F6 mechanism has no anchor for. */
export function isApproveGateDisabled(guard: ApproveGateGuard): boolean {
  if (!guard.hasWorkItem) return false;
  if (guard.checklistLoading) return true;
  return guard.checklistComplete === false;
}

// ── Related artifacts card (S5 "关联产物") ────────────────────────────────────

export interface RelatedArtifactCard {
  id: string;
  source: "sprint" | "work-item";
  docKey?: string;
  name: string;
  kind: string;
  version: number;
  producedByKind: "agent" | "human";
  excerpt?: string;
  contentRef?: string | null;
  createdAt: string;
}

const ARTIFACT_EXCERPT_LENGTH = 160;

/** Latest version per docKey from list-sprint-artifacts' `byDocKey` map — the
 *  sprint-level artifacts (sprint-doc, test-plan, …) the s5 prototype's
 *  signoff card shows. */
export function latestSprintArtifactCards(
  byDocKey: Record<string, SprintArtifact[]> | undefined,
): RelatedArtifactCard[] {
  if (!byDocKey) return [];
  const cards: RelatedArtifactCard[] = [];
  for (const [docKey, versions] of Object.entries(byDocKey)) {
    const latest = versions[versions.length - 1];
    if (!latest) continue;
    cards.push({
      id: latest.id,
      source: "sprint",
      docKey,
      name: latest.name,
      kind: latest.kind,
      version: latest.version,
      producedByKind: latest.producedByKind,
      excerpt: latest.content
        ? latest.content.slice(0, ARTIFACT_EXCERPT_LENGTH)
        : undefined,
      createdAt: latest.createdAt,
    });
  }
  return cards.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Flattened list-artifacts `byStage` map — a work item's own artifacts.
 *  Unlike sprint artifacts these have no inline `content` (only an optional
 *  `contentRef`), so there is no excerpt to show — never fabricate one. */
export function workItemArtifactCards(
  byStage: Record<string, Artifact[]> | undefined,
): RelatedArtifactCard[] {
  if (!byStage) return [];
  const cards: RelatedArtifactCard[] = Object.values(byStage)
    .flat()
    .map((a) => ({
      id: a.id,
      source: "work-item" as const,
      name: a.name,
      kind: a.kind,
      version: a.version ?? 1,
      producedByKind: a.producedByKind,
      contentRef: a.contentRef || null,
      createdAt: a.createdAt,
    }));
  return cards.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const RELATED_ARTIFACTS_LIMIT = 4;

/** Sprint artifacts first (matches the prototype's sprint-doc example), then
 *  the work item's own artifacts, capped so the card doesn't grow unbounded. */
export function combineRelatedArtifacts(
  sprintCards: RelatedArtifactCard[],
  workItemCards: RelatedArtifactCard[],
): RelatedArtifactCard[] {
  return [...sprintCards, ...workItemCards].slice(0, RELATED_ARTIFACTS_LIMIT);
}
