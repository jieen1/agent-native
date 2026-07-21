// Review-thread separation (F4 — design 02 §3 evaluation independence /
// docs/sdlc-impl-f1-f4.md §4A).
//
// On run-terminal, the reconciler wakes whoever is monitoring the run so the
// result gets reviewed + committed without a human re-prompt
// (server/engine/v3-reconciler.ts `maybeWakeOrchestrator`). BEFORE this
// module, that wake RESUMED the SAME brain thread that authored the spec and
// dispatched the run — exactly the self-review blind spot the bootstrap
// quality research flagged (design 02 §3): brain grading its own diff caught
// ZERO of the issues a later run found (B2 non-transactional writes, B3 N+1 —
// both spec-mandated, so self-review never questioned them), while grading a
// DIFFERENT session's work (M3-D) caught 5 real bugs including one critical.
//
// This module computes the structural fork: a brand-new brain thread
// ("bt_...") performs the review, never the dispatching/spec thread. It is
// pure + unit-testable (no DB/network access) — the reconciler calls
// `deriveReviewWake()` to get the tags patch + which thread id to wake, then
// itself persists the merged tags and calls
// `startBrainTurn({ threadId: reviewThreadId, phase: 'review', ... })`.

import { randomUUID } from "node:crypto";

export interface ReviewWakeDecision {
  /** The thread that authored the spec / dispatched the run. */
  specThreadId: string;
  /** The (possibly freshly-minted) thread that must run the independent review. */
  reviewThreadId: string;
  /**
   * Tags patch to merge onto `v3_runs.tags`. Idempotent — safe to apply on
   * every call, including repeat reconcile ticks for the same terminal run.
   */
  tagsPatch: { specThreadId: string; reviewThreadId: string };
  /** True the first time a reviewThreadId is minted for this run (vs. reused). */
  isNewReviewThread: boolean;
}

/**
 * Decide the review-wake fork for a terminal run, given its CURRENT
 * `v3_runs.tags`. Returns `null` when there is no dispatching brain thread to
 * fork from (`tags.brainThreadId`/`tags.specThreadId` absent) — the caller's
 * `haveThread` guard already covers this in practice; this is a defensive
 * re-check that also makes the decision directly unit-testable.
 *
 * Idempotent: if `tags` already carries a `reviewThreadId` from a prior fork,
 * the SAME id is returned rather than minting a new one — a run whose
 * terminal-wake fires more than once (should not happen given the caller's
 * `run.terminal-review-requested` idempotency guard, but kept defensive here)
 * must resume the one review thread, not spawn a new one each time.
 */
export function deriveReviewWake(
  tags: Record<string, unknown> | null | undefined,
): ReviewWakeDecision | null {
  const t =
    tags && typeof tags === "object" && !Array.isArray(tags) ? tags : {};

  const specThreadId =
    typeof t["specThreadId"] === "string" && t["specThreadId"]
      ? (t["specThreadId"] as string)
      : typeof t["brainThreadId"] === "string" && t["brainThreadId"]
        ? (t["brainThreadId"] as string)
        : null;
  if (!specThreadId) return null;

  const existingReviewThreadId =
    typeof t["reviewThreadId"] === "string" && t["reviewThreadId"]
      ? (t["reviewThreadId"] as string)
      : null;

  // Structural guarantee (T-F4-04): reviewThreadId must never equal
  // specThreadId. Mint a fresh one unless the existing value is already
  // distinct from the spec thread.
  const reuseExisting =
    existingReviewThreadId !== null && existingReviewThreadId !== specThreadId;
  const reviewThreadId = reuseExisting
    ? (existingReviewThreadId as string)
    : `bt_${randomUUID()}`;

  return {
    specThreadId,
    reviewThreadId,
    tagsPatch: { specThreadId, reviewThreadId },
    isNewReviewThread: !reuseExisting,
  };
}

export interface ReviewWakeMessageOpts {
  runId: string;
  status: "done" | "failed" | "cancelled";
  workspaceId?: string | null;
}

/**
 * Build the wake message for the freshly-forked review thread B (design 02
 * §3: independent, adversarial review of the SPEC's OWN design decisions —
 * transactionality, batching, error handling, N+1 — not only implementation
 * drift). This thread's argv has NO Bash/Edit/Write (see
 * `resolveBrainAllowedTools('review')` in brain-capability.ts); the only
 * remediation exit for a rejected run is a NEW `workflowRun` in fix mode.
 */
export function buildReviewWakeMessage(opts: ReviewWakeMessageOpts): string {
  const workspaceLine = opts.workspaceId
    ? ` Workspace: ${opts.workspaceId}.`
    : "";
  return (
    `独立评审(evaluation independence — design 02 §3):orchestrated run ` +
    `\`${opts.runId}\` reached a terminal state (${opts.status}). You are a ` +
    `FRESH review session — you did NOT author this run's spec or dispatch ` +
    `it, and you must not assume or trust that session's framing.${workspaceLine} ` +
    `Poll mcp__orchestrator__runState / mcp__orchestrator__v3RunNodes until ` +
    `every node is terminal, then independently inspect ` +
    `mcp__orchestrator__workspaceDiff and mcp__orchestrator__runSummary / ` +
    `mcp__orchestrator__nodeSummary (full_diff). Be adversarial about the ` +
    `SPEC's OWN design decisions — transactionality, batching, error ` +
    `handling, N+1 queries — not only whether the implementation drifted ` +
    `from the spec. You have NO write tools (no Bash/Edit/Write) and must ` +
    `never modify code directly. Conclude by calling ` +
    `mcp__orchestrator__runVerdict({ runId: "${opts.runId}", verdict, ` +
    `findings, reviewThreadId: <your own thread id> }) with verdict PASSED ` +
    `or CHANGES_REQUESTED. If PASSED and there are changes to ship, DELIVER ` +
    `by calling mcp__orchestrator__workspaceCommit (host-native — commits the ` +
    `feature branch and opens the PR) with createMr:true, then report the run ` +
    `id and the PR url. If ` +
    `CHANGES_REQUESTED, the ONLY remediation is a NEW ` +
    `mcp__orchestrator__workflowRun (fix mode) carrying your findings — do ` +
    `not attempt to fix anything yourself. If this same work item has now ` +
    `failed review across MULTIPLE consecutive CHANGES_REQUESTED rounds (a ` +
    `repeat failure, not the first), break the loop: dispatch the new ` +
    `fix-mode workflowRun with a DIFFERENT development engine by passing a ` +
    `different \`devEngine\` input (the sdlc-dev \`develop\` node runs on ` +
    `\`agent: inputs.devEngine\`, default \`vllm\`, and also honors ` +
    `\`engine_override\`), e.g. switch \`vllm\` -> \`claude-code\` or vice ` +
    `versa, so a different agent/model attempts the fix instead of re-running ` +
    `the identical path that already failed. Do not start unrelated new runs.`
  );
}
