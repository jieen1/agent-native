// Inbox aggregation — the single query implementation behind both
// `actions/list-inbox.ts` (full rows for the /inbox page) and
// `actions/view-screen.ts` (counts only, when the user is looking at /inbox).
//
// Real data sources only (see docs/sdlc-product-design/03-tracker.md §2 for
// the aspirational v2.2 design, and the R3 task report for what shipped):
//   - 签核 (signoff)         tracker_approvals, gateKey ∈ {plan-signoff, design-signoff}, status=pending
//   - 裁决 (escalation)      tracker_approvals, gateKey ∈ {escalation, audit-deferral}, status=pending
//     (escalation/audit-deferral are real GateKey values — same approvals
//     table as signoff, not a separate data source; see shared/types.ts.)
//   - 评审请求 (review-request)  tracker_work_items where currentStageName='验收'
//     ('验收' is the REAL DB value — server/lib/transition-guard.ts normalizes
//     it to the guard-facing label "待人工评审"; that label is never written
//     to the column itself, see currentGuardState()).
//   - 失败路由 (failed-routing)  tracker_work_items where status='failed'
//   - 通知 (notifications)   no cross-item activity/event feed action exists
//     (list-tracker-activities is scoped to one workItemId; list-audit-events
//     only carries declared audit targets for 2 of ~30 mutating actions) —
//     intentionally returns empty rather than fabricating events.
import { and, desc, eq } from "drizzle-orm";

import { getDb, schema } from "../db/index.js";
import { ownerScope } from "./access.js";
import { computeItemKeyDisplays } from "./item-key-display.js";

export type InboxGroupKey =
  | "signoff"
  | "escalation"
  | "reviewRequest"
  | "failedRouting"
  | "notifications";

export interface InboxRow {
  /** Stable id for the row — an approval id or a work item id. */
  id: string;
  group: InboxGroupKey;
  /** gateKey for approval rows, "review-request" / "failed" for work-item rows. */
  kind: string;
  title: string;
  summary: string;
  status: string;
  /** ISO timestamp the UI derives "相对时间" from. */
  timestamp: string;
  approvalId?: string;
  gateKey?: string;
  workItemId?: string;
  sprintId?: string | null;
  itemKey?: string;
  itemKeyDisplay?: string;
  projectId?: string;
  currentStageName?: string;
  branch?: string | null;
  requestedBy?: string;
}

export interface InboxGroups {
  signoff: InboxRow[];
  escalation: InboxRow[];
  reviewRequest: InboxRow[];
  failedRouting: InboxRow[];
  notifications: InboxRow[];
}

export interface InboxCounts {
  signoff: number;
  escalation: number;
  reviewRequest: number;
  failedRouting: number;
  notifications: number;
  total: number;
}

const SIGNOFF_GATE_KEYS = new Set(["plan-signoff", "design-signoff"]);
const ESCALATION_GATE_KEYS = new Set(["escalation", "audit-deferral"]);

const LIMIT = 200;

type Db = ReturnType<typeof getDb>;

/** Build the full inbox — grouped rows + counts. Scoped to the current
 *  request's owner/org via `ownerScope()` on every underlying table. */
export async function buildInboxGroups(db: Db = getDb()): Promise<{
  groups: InboxGroups;
  counts: InboxCounts;
}> {
  const pendingApprovals = await db
    .select()
    .from(schema.approvals)
    .where(
      and(ownerScope(schema.approvals), eq(schema.approvals.status, "pending")),
    )
    .orderBy(desc(schema.approvals.createdAt))
    .limit(LIMIT);

  const signoffApprovals = pendingApprovals.filter((a) =>
    SIGNOFF_GATE_KEYS.has(a.gateKey),
  );
  const escalationApprovals = pendingApprovals.filter((a) =>
    ESCALATION_GATE_KEYS.has(a.gateKey),
  );

  const reviewRequestItems = await db
    .select({
      id: schema.workItems.id,
      projectId: schema.workItems.projectId,
      sprintId: schema.workItems.sprintId,
      itemKey: schema.workItems.itemKey,
      title: schema.workItems.title,
      description: schema.workItems.description,
      status: schema.workItems.status,
      currentStageName: schema.workItems.currentStageName,
      branch: schema.workItems.branch,
      dispatchedAt: schema.workItems.dispatchedAt,
      updatedAt: schema.workItems.updatedAt,
    })
    .from(schema.workItems)
    .where(
      and(
        ownerScope(schema.workItems),
        eq(schema.workItems.currentStageName, "验收"),
      ),
    )
    .orderBy(desc(schema.workItems.updatedAt))
    .limit(LIMIT);

  const failedItems = await db
    .select({
      id: schema.workItems.id,
      projectId: schema.workItems.projectId,
      sprintId: schema.workItems.sprintId,
      itemKey: schema.workItems.itemKey,
      title: schema.workItems.title,
      description: schema.workItems.description,
      status: schema.workItems.status,
      currentStageName: schema.workItems.currentStageName,
      branch: schema.workItems.branch,
      dispatchedAt: schema.workItems.dispatchedAt,
      updatedAt: schema.workItems.updatedAt,
    })
    .from(schema.workItems)
    .where(
      and(ownerScope(schema.workItems), eq(schema.workItems.status, "failed")),
    )
    .orderBy(desc(schema.workItems.updatedAt))
    .limit(LIMIT);

  const itemKeyDisplays = await computeItemKeyDisplays(db, [
    ...reviewRequestItems.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      itemKey: r.itemKey,
    })),
    ...failedItems.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      itemKey: r.itemKey,
    })),
  ]);

  function approvalRow(
    a: (typeof pendingApprovals)[number],
    group: "signoff" | "escalation",
  ): InboxRow {
    return {
      id: a.id,
      group,
      kind: a.gateKey,
      title: a.gateKey,
      summary: [
        `Sprint ${a.sprintId}`,
        a.workItemId ? `工作项 ${a.workItemId}` : null,
        `发起人 ${a.requestedBy}`,
      ]
        .filter(Boolean)
        .join(" · "),
      status: a.status,
      timestamp: a.createdAt,
      approvalId: a.id,
      gateKey: a.gateKey,
      workItemId: a.workItemId ?? undefined,
      sprintId: a.sprintId,
      requestedBy: a.requestedBy,
    };
  }

  function workItemRow(
    r: (typeof reviewRequestItems)[number],
    group: "reviewRequest" | "failedRouting",
    kind: string,
  ): InboxRow {
    return {
      id: r.id,
      group,
      kind,
      title: r.title,
      summary: r.description ?? "",
      status: r.status,
      timestamp: r.updatedAt,
      workItemId: r.id,
      sprintId: r.sprintId,
      itemKey: r.itemKey,
      itemKeyDisplay: itemKeyDisplays.get(r.id) ?? r.itemKey,
      projectId: r.projectId,
      currentStageName: r.currentStageName,
      branch: r.branch,
    };
  }

  const groups: InboxGroups = {
    signoff: signoffApprovals.map((a) => approvalRow(a, "signoff")),
    escalation: escalationApprovals.map((a) => approvalRow(a, "escalation")),
    reviewRequest: reviewRequestItems.map((r) =>
      workItemRow(r, "reviewRequest", "review-request"),
    ),
    failedRouting: failedItems.map((r) =>
      workItemRow(r, "failedRouting", "failed"),
    ),
    // No real cross-item event-feed data source exists yet — see module docblock.
    notifications: [],
  };

  const counts: InboxCounts = {
    signoff: groups.signoff.length,
    escalation: groups.escalation.length,
    reviewRequest: groups.reviewRequest.length,
    failedRouting: groups.failedRouting.length,
    notifications: 0,
    total:
      groups.signoff.length +
      groups.escalation.length +
      groups.reviewRequest.length +
      groups.failedRouting.length,
  };

  return { groups, counts };
}
