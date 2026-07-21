import { describe, expect, it } from "vitest";

import {
  deriveItemStatus,
  deriveWritebackStage,
  extractDelivery,
} from "../get-activity.js";

describe("deriveItemStatus", () => {
  it("stays running/queued while the slot is live, regardless of delivery", () => {
    expect(deriveItemStatus("running", true)).toBe("running");
    expect(deriveItemStatus("queued", true)).toBe("queued");
  });

  it("F3: a terminal done slot derives `returned` — review pending, not done", () => {
    expect(deriveItemStatus("done", false)).toBe("returned");
  });

  it("recovers a failed slot to `returned` when a strong delivery lands after the failure", () => {
    // The exact shape of the M3-D / brain-UI-bug-fix regression found
    // 2026-07-08: an orchestrator container restart marked the slot failed
    // mid-turn, but the thread was resumed and genuinely finished afterward.
    // F3: recovery lands at `returned` (was `done` pre-guard).
    expect(
      deriveItemStatus("failed", true, {
        isStrongDelivery: true,
        slotUpdatedAt: "2026-07-08T12:31:24.460Z",
        latestEventAt: "2026-07-08T13:04:00.000Z",
      }),
    ).toBe("returned");
  });

  it("does not recover a failed slot when there is no delivery at all", () => {
    expect(
      deriveItemStatus("failed", false, {
        isStrongDelivery: false,
        slotUpdatedAt: "2026-07-08T11:13:48.696Z",
        latestEventAt: "2026-07-08T14:03:10.034Z",
      }),
    ).toBe("failed");
  });

  it("does not recover a failed slot from a weak (single-signal) delivery", () => {
    // A bare commit-looking hash mentioned while the thread reads its own
    // `git log` output mid-debug must never alone flip the item to done.
    expect(
      deriveItemStatus("failed", true, {
        isStrongDelivery: false,
        slotUpdatedAt: "2026-07-08T12:00:00.000Z",
        latestEventAt: "2026-07-08T13:00:00.000Z",
      }),
    ).toBe("failed");
  });

  it("does not recover a failed slot when there is no activity newer than the failure", () => {
    expect(
      deriveItemStatus("failed", true, {
        isStrongDelivery: true,
        slotUpdatedAt: "2026-07-08T13:00:00.000Z",
        latestEventAt: "2026-07-08T12:00:00.000Z",
      }),
    ).toBe("failed");
  });

  it("falls back to a weak delivery signal only when there is no slot row at all — capped at `returned`", () => {
    expect(deriveItemStatus(null, true)).toBe("returned");
    expect(deriveItemStatus(null, false)).toBe(null);
  });
});

// ============================================================================
// T-F3-17: get-activity 轮询回写不落 done (SDLC-058 最后一条未守卫直写通道)
// ============================================================================

describe("T-F3-17: 轮询回写永不写 done、阶段封顶「验收」", () => {
  const ALL_SLOT_STATES = [
    "running",
    "queued",
    "done",
    "failed",
    "cancelled",
    null,
  ];
  const ALL_DELIVERY = [true, false];

  it("deriveItemStatus never returns 'done' for ANY slot × delivery × recovery combination", () => {
    for (const slot of ALL_SLOT_STATES) {
      for (const hasDelivery of ALL_DELIVERY) {
        for (const strong of ALL_DELIVERY) {
          const result = deriveItemStatus(slot, hasDelivery, {
            isStrongDelivery: strong,
            slotUpdatedAt: "2026-07-08T12:00:00.000Z",
            latestEventAt: "2026-07-08T13:00:00.000Z",
          });
          expect(result).not.toBe("done");
          const resultNoRecovery = deriveItemStatus(slot, hasDelivery);
          expect(resultNoRecovery).not.toBe("done");
        }
      }
    }
  });

  it("run returned + strong delivery (PR) → stage advances to 验收 and NO further", () => {
    expect(deriveWritebackStage("returned", "实施", true)).toBe("验收");
    expect(deriveWritebackStage("returned", "测试", true)).toBe("验收");
    // Already at 验收 / 交付 → no change (never advances into 交付/done).
    expect(deriveWritebackStage("returned", "验收", true)).toBe(null);
    expect(deriveWritebackStage("returned", "交付", true)).toBe(null);
  });

  it("run returned without a strong delivery → stage advances only to 测试", () => {
    expect(deriveWritebackStage("returned", "实施", false)).toBe("测试");
    expect(deriveWritebackStage("returned", "待办", false)).toBe("测试");
    expect(deriveWritebackStage("returned", "测试", false)).toBe(null);
    expect(deriveWritebackStage("returned", "验收", false)).toBe(null);
  });

  it("non-returned statuses never move the stage", () => {
    for (const s of ["running", "queued", "failed", "done", null]) {
      expect(deriveWritebackStage(s, "实施", true)).toBe(null);
    }
  });

  it("deriveWritebackStage never emits 交付 or a done-like value for any input", () => {
    const stages = [
      "待办",
      "分析",
      "设计",
      "实施",
      "测试",
      "验收",
      "交付",
      null,
      "怪值",
    ];
    for (const s of ["returned", "running", "failed", null]) {
      for (const cur of stages) {
        for (const strong of [true, false]) {
          const out = deriveWritebackStage(s, cur, strong);
          expect(out === null || out === "测试" || out === "验收").toBe(true);
        }
      }
    }
  });
});

describe("extractDelivery", () => {
  it("marks a real PR URL as strong on its own", () => {
    const events = [
      { text: "Pushed and opened https://github.com/x/y/pull/42" },
    ];
    const delivery = extractDelivery(events);
    expect(delivery?.isStrong).toBe(true);
  });

  it("marks a branch+commit pair as strong", () => {
    const events = [
      {
        text: "Committed and pushed sha 1234567 on branch orchestrator/run-abc",
      },
    ];
    const delivery = extractDelivery(events);
    expect(delivery?.branch).toBeTruthy();
    expect(delivery?.commit).toBeTruthy();
    expect(delivery?.isStrong).toBe(true);
  });

  it("does not mark a bare stray commit-looking hash as strong", () => {
    // The exact false-positive found 2026-07-08: a thread scanning its own
    // `git log --oneline` tool output, with no branch and no PR mentioned.
    const events = [
      { text: "commit d44ddf63 feat(orchestrator): unrelated prior work" },
    ];
    const delivery = extractDelivery(events);
    expect(delivery?.commit).toBeTruthy();
    expect(delivery?.branch).toBeFalsy();
    expect(delivery?.isStrong).toBe(false);
  });

  it("returns null when nothing delivery-shaped is found", () => {
    const events = [{ text: "Still investigating the failure." }];
    expect(extractDelivery(events)).toBe(null);
  });
});
