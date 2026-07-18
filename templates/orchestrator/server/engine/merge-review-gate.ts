// Task board #95 — mandatory independent-review gate ahead of
// `workspaceMergePr`. Pure decision logic (no DB), so the gate itself is
// unit-testable without mocking Postgres or a DAG dispatch.
//
// Today `workspaceMergePr` only re-asserts CI-green/no-conflicts right before
// merging (server/v3-workspace-local.ts's mergePr, untouched by this task) —
// correct, but it never forces a genuinely independent second pass over the
// diff. The DAG's own dev/review nodes (sdlc-review's `review1`/`review2`/
// `review3`, workflow-library-seed.ts) already produce a verdict, but that
// verdict comes from the SAME run that wrote the code, using the SAME cached
// diff context those nodes already had. This gate instead requires a
// SEPARATE run of the dedicated `sdlc-merge-review` template (own dispatch,
// own workspace-scoped `agent:"claude-code"` node that re-fetches the real
// diff itself via `git diff`/`gh pr diff` rather than trusting any prior
// summary) before the merge control's button is enabled.
//
// The verdict is never re-copied into a second table — it's read live off
// that review run's own output (mirrors how `runSummary`/`nodeSummary`
// already read node output). The ONE new durable fact is a human's explicit
// override (recorded in `v3_merge_overrides` by the `mergeReviewOverride`
// action), so this gate is a soft, appealable check — not an unappealable
// block — while still requiring an explicit reason instead of a silent
// bypass.

export type MergeReviewVerdict = "safe_to_merge" | "concerns_found";

export type MergeReviewStatus =
  | "pending"
  | "running"
  | "paused"
  | "done"
  | "failed"
  | "cancelled";

/** A snapshot of the latest `sdlc-merge-review` run for a workspace (or null
 *  when none has ever been started). */
export interface MergeReviewSnapshot {
  reviewRunId: string;
  status: MergeReviewStatus;
  verdict: MergeReviewVerdict | null;
  summary: string | null;
  findings: unknown[] | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

/** A human's recorded "I saw the findings, merge anyway" decision (or null
 *  when none has been recorded for this workspace). */
export interface MergeOverrideSnapshot {
  /** The review run this override was granted against — null when a human
   *  overrode before any review had ever been run for this workspace. */
  reviewRunId: string | null;
  reason: string;
  overriddenBy: string | null;
  createdAt: string | null;
}

export type MergeGateSource = "review-passed" | "human-override" | "blocked";

export interface MergeGateResult {
  canMerge: boolean;
  source: MergeGateSource;
  /** Human-readable (Chinese, matching this page's existing convention)
   *  explanation — surfaced as the merge button's disabled title/tooltip. */
  reason: string;
}

/**
 * True when a recorded override still applies to the CURRENT latest review.
 * An override is pinned to the review run id it was granted against (or to
 * "no review yet", i.e. `reviewRunId: null`) — a NEW review run for the same
 * workspace (e.g. after further fixes, or a worse regression) is a different
 * id, so a stale override never silently re-applies to a diff nobody has
 * looked at. A fresh override must be recorded for the new review to unblock
 * merge again (or the new review must itself pass).
 */
function overrideMatchesLatestReview(
  review: MergeReviewSnapshot | null,
  override: MergeOverrideSnapshot,
): boolean {
  if (!review) return override.reviewRunId === null;
  return override.reviewRunId === review.reviewRunId;
}

function blockedReason(review: MergeReviewSnapshot | null): string {
  if (!review) return "尚未运行独立复核，无法合并";
  switch (review.status) {
    case "pending":
    case "running":
    case "paused":
      return "独立复核进行中，完成前无法合并";
    case "failed":
      return "独立复核未能完成（运行失败），需人工确认后才能合并";
    case "cancelled":
      return "独立复核已取消，需人工确认后才能合并";
    case "done":
      return review.verdict === "concerns_found"
        ? "独立复核发现问题，需人工确认后才能合并"
        : "独立复核未给出可合并结论，需人工确认后才能合并";
    default:
      return "独立复核尚未通过，无法合并";
  }
}

/**
 * Decide whether the independent-review gate allows a merge. Pure — no I/O.
 * `mergeReviewGet` (actions/merge-review.ts) is the only caller that loads
 * real `review`/`override` snapshots from the DB and calls this.
 */
export function computeMergeGate(args: {
  review: MergeReviewSnapshot | null;
  override: MergeOverrideSnapshot | null;
}): MergeGateResult {
  const { review, override } = args;

  if (
    review &&
    review.status === "done" &&
    review.verdict === "safe_to_merge"
  ) {
    return {
      canMerge: true,
      source: "review-passed",
      reason: "独立复核通过：未发现需要阻塞合并的问题",
    };
  }

  if (override && overrideMatchesLatestReview(review, override)) {
    return {
      canMerge: true,
      source: "human-override",
      reason: `已人工确认合并：${override.reason}`,
    };
  }

  return {
    canMerge: false,
    source: "blocked",
    reason: blockedReason(review),
  };
}
