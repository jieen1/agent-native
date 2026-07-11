// F4 spec/评审线程分离 — 结构性单元测试(docs/sdlc-impl-f1-f4.md §6.4
// T-F4-04 的可单测半:deriveReviewWake 的分叉决策与幂等;完整的
// "隔离窗口跑一单查 v3_runs.tags 与 brain_threads" 属 101 集成)。

import { describe, it, expect } from "vitest";
import { buildReviewWakeMessage, deriveReviewWake } from "../review-thread.js";

describe("T-F4-04 (unit) — deriveReviewWake 结构性分叉", () => {
  it("returns null when there is no dispatching brain thread in tags", () => {
    expect(deriveReviewWake(null)).toBeNull();
    expect(deriveReviewWake(undefined)).toBeNull();
    expect(deriveReviewWake({})).toBeNull();
    expect(deriveReviewWake({ brainThreadId: "" })).toBeNull();
  });

  it("mints a FRESH bt_ review thread distinct from the spec thread", () => {
    const d = deriveReviewWake({ brainThreadId: "bt_spec-1" });
    expect(d).not.toBeNull();
    expect(d!.specThreadId).toBe("bt_spec-1");
    expect(d!.reviewThreadId).toMatch(/^bt_/);
    expect(d!.reviewThreadId).not.toBe(d!.specThreadId);
    expect(d!.isNewReviewThread).toBe(true);
    expect(d!.tagsPatch).toEqual({
      specThreadId: "bt_spec-1",
      reviewThreadId: d!.reviewThreadId,
    });
  });

  it("prefers an explicit specThreadId tag over brainThreadId", () => {
    const d = deriveReviewWake({
      specThreadId: "bt_spec-explicit",
      brainThreadId: "bt_dispatcher",
    });
    expect(d!.specThreadId).toBe("bt_spec-explicit");
  });

  it("is idempotent: reuses an existing DISTINCT reviewThreadId instead of minting", () => {
    const d = deriveReviewWake({
      brainThreadId: "bt_spec-1",
      reviewThreadId: "bt_review-1",
    });
    expect(d!.reviewThreadId).toBe("bt_review-1");
    expect(d!.isNewReviewThread).toBe(false);
  });

  it("re-mints when the stored reviewThreadId EQUALS the spec thread (corrupted state)", () => {
    const d = deriveReviewWake({
      brainThreadId: "bt_spec-1",
      reviewThreadId: "bt_spec-1",
    });
    expect(d!.reviewThreadId).not.toBe("bt_spec-1");
    expect(d!.reviewThreadId).toMatch(/^bt_/);
    expect(d!.isNewReviewThread).toBe(true);
  });

  it("two forks over the same tags mint different fresh ids (no reuse without persistence)", () => {
    const a = deriveReviewWake({ brainThreadId: "bt_s" })!;
    const b = deriveReviewWake({ brainThreadId: "bt_s" })!;
    expect(a.reviewThreadId).not.toBe(b.reviewThreadId);
  });
});

describe("buildReviewWakeMessage — 评审唤醒消息契约", () => {
  const msg = buildReviewWakeMessage({ runId: "r-42", status: "done" });

  it("names the run + terminal status and demands independence", () => {
    expect(msg).toContain("r-42");
    expect(msg).toContain("done");
    expect(msg).toContain("FRESH review session");
  });

  it("teaches runVerdict as the conclusion channel", () => {
    expect(msg).toContain("mcp__orchestrator__runVerdict");
    expect(msg).toContain("PASSED");
    expect(msg).toContain("CHANGES_REQUESTED");
  });

  it("states the ONLY remediation exit = new workflowRun (fix mode) and no write tools", () => {
    expect(msg).toContain("mcp__orchestrator__workflowRun");
    expect(msg).toMatch(/NO write tools/);
    expect(msg).toMatch(/fix mode/);
  });

  it("includes the delivery path for PASSED (host-native workspaceCommit)", () => {
    expect(msg).toContain("mcp__orchestrator__workspaceCommit");
    expect(msg).toContain("createMr:true");
  });
});
