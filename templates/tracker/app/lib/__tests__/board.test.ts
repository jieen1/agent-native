import type { ActivityResponse } from "@shared/types";
import { describe, expect, it } from "vitest";

import {
  classifyBoardDrop,
  firstFailureSummary,
  initialsFromOwner,
  isColumnSlim,
  miniStepDots,
  miniStepSequence,
  resolveCardActor,
  runningQueuedCounts,
  STAGE_RING_STATUS,
} from "@/lib/board";

// ── isColumnSlim (issue #1) ──────────────────────────────────────────────────

describe("isColumnSlim", () => {
  it("slims a structural column when it has zero cards", () => {
    expect(isColumnSlim("待办", 0)).toBe(true);
    expect(isColumnSlim("分析", 0)).toBe(true);
    expect(isColumnSlim("设计", 0)).toBe(true);
    expect(isColumnSlim("交付", 0)).toBe(true);
  });

  it("un-slims a structural column once it holds a card", () => {
    expect(isColumnSlim("待办", 1)).toBe(false);
    expect(isColumnSlim("交付", 2)).toBe(false);
  });

  it("keeps 实施/测试/验收 full width even at zero cards (active + gate columns)", () => {
    expect(isColumnSlim("实施", 0)).toBe(false);
    expect(isColumnSlim("测试", 0)).toBe(false);
    expect(isColumnSlim("验收", 0)).toBe(false);
  });
});

// ── STAGE_RING_STATUS (issue #2) ─────────────────────────────────────────────

describe("STAGE_RING_STATUS", () => {
  it("gives every non-terminal stage a fixed StatusRing identity", () => {
    expect(STAGE_RING_STATUS["待办"]).toBe("pending");
    expect(STAGE_RING_STATUS["分析"]).toBe("pending");
    expect(STAGE_RING_STATUS["设计"]).toBe("review");
    expect(STAGE_RING_STATUS["实施"]).toBe("running");
    expect(STAGE_RING_STATUS["测试"]).toBe("running");
    expect(STAGE_RING_STATUS["验收"]).toBe("gate");
  });

  it("does not map 交付 (terminal stage uses StatusIcon, never StatusRing)", () => {
    expect(STAGE_RING_STATUS["交付"]).toBeUndefined();
  });
});

// ── runningQueuedCounts (issue #3) ───────────────────────────────────────────

describe("runningQueuedCounts", () => {
  it("counts running/dispatched as running and queued separately", () => {
    expect(
      runningQueuedCounts([
        { status: "running" },
        { status: "dispatched" },
        { status: "queued" },
        { status: "open" },
        { status: "failed" },
      ]),
    ).toEqual({ running: 2, queued: 1 });
  });

  it("returns zeros for an empty or idle column", () => {
    expect(runningQueuedCounts([])).toEqual({ running: 0, queued: 0 });
    expect(runningQueuedCounts([{ status: "done" }])).toEqual({
      running: 0,
      queued: 0,
    });
  });
});

// ── classifyBoardDrop (issue #4 — the drag gate matrix) ──────────────────────

describe("classifyBoardDrop", () => {
  it("is a noop when dropped on its own column", () => {
    expect(classifyBoardDrop("实施", "实施")).toEqual({ kind: "noop" });
  });

  it("locks 实施⇄测试 in both directions (writeback/人工完成-only)", () => {
    expect(classifyBoardDrop("实施", "测试")).toEqual({
      kind: "locked-active",
    });
    expect(classifyBoardDrop("测试", "实施")).toEqual({
      kind: "locked-active",
    });
  });

  it("treats every other one-step forward move as a sprint-advance request", () => {
    expect(classifyBoardDrop("待办", "分析")).toEqual({
      kind: "sprint-advance",
      fromStage: "待办",
    });
    expect(classifyBoardDrop("分析", "设计")).toEqual({
      kind: "sprint-advance",
      fromStage: "分析",
    });
    // 设计→实施: the sprint's planning→executing boundary.
    expect(classifyBoardDrop("设计", "实施")).toEqual({
      kind: "sprint-advance",
      fromStage: "设计",
    });
    // 测试→验收: exactly the prototype's demoed drag-into-验收 scenario.
    expect(classifyBoardDrop("测试", "验收")).toEqual({
      kind: "sprint-advance",
      fromStage: "测试",
    });
    // 验收→交付: sprint-advance is still requested; the server-side
    // advance-stage guards 交付 itself (GUARDED_FINAL_STAGE) and reports
    // delivery-guarded rather than mutating — the UI surfaces that reason.
    expect(classifyBoardDrop("验收", "交付")).toEqual({
      kind: "sprint-advance",
      fromStage: "验收",
    });
  });

  it("rejects a forward skip-drop (more than one column at a time)", () => {
    expect(classifyBoardDrop("待办", "设计")).toEqual({
      kind: "skip-forbidden",
    });
    expect(classifyBoardDrop("实施", "验收")).toEqual({
      kind: "skip-forbidden",
    });
  });

  it("treats a one-step backward move as a rollback", () => {
    expect(classifyBoardDrop("分析", "待办")).toEqual({
      kind: "rollback",
      fromStage: "分析",
      toStage: "待办",
    });
    expect(classifyBoardDrop("交付", "验收")).toEqual({
      kind: "rollback",
      fromStage: "交付",
      toStage: "验收",
    });
  });

  it("rejects a backward skip-drop", () => {
    expect(classifyBoardDrop("交付", "测试")).toEqual({
      kind: "skip-forbidden",
    });
  });
});

// ── resolveCardActor / initialsFromOwner (issue #6) ──────────────────────────

describe("resolveCardActor", () => {
  it("maps the literal agent owner values to kind=agent", () => {
    expect(resolveCardActor("agent")).toEqual({ kind: "agent" });
    expect(resolveCardActor("智能体")).toEqual({ kind: "agent" });
  });

  it("maps an email owner to kind=human with derived initials", () => {
    expect(resolveCardActor("steve.jobs@example.com")).toEqual({
      kind: "human",
      initials: "SJ",
    });
  });

  it("falls back to an unassigned human placeholder", () => {
    expect(resolveCardActor(null)).toEqual({ kind: "human" });
    expect(resolveCardActor(undefined)).toEqual({ kind: "human" });
  });
});

describe("initialsFromOwner", () => {
  it("takes the first letter of the first two dot/dash/space-separated parts", () => {
    expect(initialsFromOwner("steve.jobs@example.com")).toBe("SJ");
    expect(initialsFromOwner("lin-wang@example.com")).toBe("LW");
    expect(initialsFromOwner("tanaka kenji")).toBe("TK");
  });

  it("falls back to the first two characters for a single-word owner", () => {
    expect(initialsFromOwner("steve")).toBe("ST");
  });
});

// ── firstFailureSummary (issue #9) ───────────────────────────────────────────

describe("firstFailureSummary", () => {
  function activityWith(
    nodes: { status: string; error?: string | null; nodeIdInDag?: string }[],
  ): ActivityResponse {
    return {
      dispatched: true,
      thread: null,
      events: [],
      runs: [
        {
          id: "run_1",
          status: "failed",
          nodes: nodes.map((n, i) => ({
            nodeIdInDag: n.nodeIdInDag ?? `node-${i}`,
            status: n.status,
            error: n.error ?? null,
          })),
        },
      ],
      spawns: [],
    };
  }

  it("returns the first failing node's real error text", () => {
    const activity = activityWith([
      { status: "done" },
      { status: "failed", error: "gitRemote 认证失败 · permanent" },
    ]);
    expect(firstFailureSummary(activity)).toBe(
      "gitRemote 认证失败 · permanent",
    );
  });

  it("returns null when there is no failing node with error text", () => {
    expect(firstFailureSummary(activityWith([{ status: "done" }]))).toBeNull();
    expect(firstFailureSummary(undefined)).toBeNull();
  });
});

// ── mini-step (issue #8) ─────────────────────────────────────────────────────

describe("miniStepSequence", () => {
  it("uses the full 7-stage order when plannedStages is absent or empty", () => {
    expect(miniStepSequence(undefined)).toHaveLength(7);
    expect(miniStepSequence([])).toHaveLength(7);
  });

  it("uses the full order when plannedStages covers all 7 (not a real subset)", () => {
    expect(
      miniStepSequence([
        "待办",
        "分析",
        "设计",
        "实施",
        "测试",
        "验收",
        "交付",
      ]),
    ).toHaveLength(7);
  });

  it("uses the planned subset when it is genuinely partial", () => {
    expect(miniStepSequence(["实施", "测试"])).toEqual(["实施", "测试"]);
  });
});

describe("miniStepDots", () => {
  it("marks stages before current as done, current as active, rest as future", () => {
    const seq = [
      "待办",
      "分析",
      "设计",
      "实施",
      "测试",
      "验收",
      "交付",
    ] as const;
    expect(miniStepDots([...seq], "实施", "running")).toEqual([
      "done",
      "done",
      "done",
      "active",
      "future",
      "future",
      "future",
    ]);
  });

  it("marks the current stage as failed when status is failed", () => {
    expect(miniStepDots(["实施", "测试"], "实施", "failed")).toEqual([
      "failed",
      "future",
    ]);
  });

  it("treats every dot as future when currentStageName isn't in the sequence", () => {
    expect(miniStepDots(["实施", "测试"], "验收", "running")).toEqual([
      "future",
      "future",
    ]);
  });
});
