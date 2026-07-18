import { describe, expect, it } from "vitest";

import {
  computeMergeGate,
  type MergeOverrideSnapshot,
  type MergeReviewSnapshot,
} from "./merge-review-gate.js";

function review(
  overrides: Partial<MergeReviewSnapshot> = {},
): MergeReviewSnapshot {
  return {
    reviewRunId: "v3r_review1",
    status: "done",
    verdict: "safe_to_merge",
    summary: "No blocking issues found.",
    findings: [],
    startedAt: "2026-07-18T00:00:00.000Z",
    completedAt: "2026-07-18T00:05:00.000Z",
    error: null,
    ...overrides,
  };
}

describe("computeMergeGate", () => {
  it("blocks merge when no review has ever been run", () => {
    const result = computeMergeGate({ review: null, override: null });
    expect(result.canMerge).toBe(false);
    expect(result.source).toBe("blocked");
    expect(result.reason).toContain("尚未运行独立复核");
  });

  it("blocks merge while the review is still running", () => {
    const result = computeMergeGate({
      review: review({ status: "running", verdict: null }),
      override: null,
    });
    expect(result.canMerge).toBe(false);
    expect(result.reason).toContain("进行中");
  });

  it("allows merge once the review passes with a safe_to_merge verdict", () => {
    const result = computeMergeGate({
      review: review({ status: "done", verdict: "safe_to_merge" }),
      override: null,
    });
    expect(result.canMerge).toBe(true);
    expect(result.source).toBe("review-passed");
  });

  it("blocks merge when the review flags concerns and there is no override", () => {
    const result = computeMergeGate({
      review: review({ status: "done", verdict: "concerns_found" }),
      override: null,
    });
    expect(result.canMerge).toBe(false);
    expect(result.source).toBe("blocked");
    expect(result.reason).toContain("发现问题");
  });

  it("blocks merge when the review run itself failed", () => {
    const result = computeMergeGate({
      review: review({
        status: "failed",
        verdict: null,
        error: "spawn timed out",
      }),
      override: null,
    });
    expect(result.canMerge).toBe(false);
    expect(result.reason).toContain("运行失败");
  });

  it("allows merge via a human override that matches the flagged review", () => {
    const flagged = review({ status: "done", verdict: "concerns_found" });
    const override: MergeOverrideSnapshot = {
      reviewRunId: flagged.reviewRunId,
      reason: "误报，evidence 已核实过了",
      overriddenBy: "human@example.com",
      createdAt: "2026-07-18T01:00:00.000Z",
    };
    const result = computeMergeGate({ review: flagged, override });
    expect(result.canMerge).toBe(true);
    expect(result.source).toBe("human-override");
    expect(result.reason).toContain("误报");
  });

  it("allows merge via an override recorded before any review ever ran", () => {
    const override: MergeOverrideSnapshot = {
      reviewRunId: null,
      reason: "hotfix, skipping review by design",
      overriddenBy: "human@example.com",
      createdAt: "2026-07-18T01:00:00.000Z",
    };
    const result = computeMergeGate({ review: null, override });
    expect(result.canMerge).toBe(true);
    expect(result.source).toBe("human-override");
  });

  it("does NOT let a stale override silently re-apply to a NEW review run", () => {
    // A human overrode review #1's flagged verdict...
    const overrideForFirstReview: MergeOverrideSnapshot = {
      reviewRunId: "v3r_review1",
      reason: "reviewed manually, fine to merge",
      overriddenBy: "human@example.com",
      createdAt: "2026-07-18T01:00:00.000Z",
    };
    // ...but a SECOND, later review run has since been started for the same
    // workspace (e.g. more commits landed) and is still pending judgement.
    const secondReview = review({
      reviewRunId: "v3r_review2",
      status: "running",
      verdict: null,
    });
    const result = computeMergeGate({
      review: secondReview,
      override: overrideForFirstReview,
    });
    expect(result.canMerge).toBe(false);
    expect(result.source).toBe("blocked");
  });

  it("re-blocks after a new flagged review even though an older override exists", () => {
    const overrideForFirstReview: MergeOverrideSnapshot = {
      reviewRunId: "v3r_review1",
      reason: "reviewed manually, fine to merge",
      overriddenBy: "human@example.com",
      createdAt: "2026-07-18T01:00:00.000Z",
    };
    const secondReviewFlagged = review({
      reviewRunId: "v3r_review2",
      status: "done",
      verdict: "concerns_found",
    });
    const result = computeMergeGate({
      review: secondReviewFlagged,
      override: overrideForFirstReview,
    });
    expect(result.canMerge).toBe(false);
    expect(result.source).toBe("blocked");
  });

  it("a review-passed verdict wins even when a stale override also exists", () => {
    const stale: MergeOverrideSnapshot = {
      reviewRunId: "v3r_review1",
      reason: "old override",
      overriddenBy: "human@example.com",
      createdAt: "2026-07-18T01:00:00.000Z",
    };
    const passed = review({
      reviewRunId: "v3r_review2",
      status: "done",
      verdict: "safe_to_merge",
    });
    const result = computeMergeGate({ review: passed, override: stale });
    expect(result.canMerge).toBe(true);
    expect(result.source).toBe("review-passed");
  });
});
