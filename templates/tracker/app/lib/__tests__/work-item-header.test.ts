import { describe, expect, it } from "vitest";

import { canEscalateWorkItem, stageNeighbors } from "../work-item-header.js";

const STAGES = [
  "待办",
  "分析",
  "设计",
  "实施",
  "测试",
  "验收",
  "交付",
] as const;

describe("stageNeighbors", () => {
  it("returns both neighbors for a middle stage", () => {
    expect(stageNeighbors(STAGES, "设计")).toEqual({
      nextStage: "实施",
      prevStage: "分析",
    });
  });

  it("has no prevStage at the first stage", () => {
    expect(stageNeighbors(STAGES, "待办")).toEqual({
      nextStage: "分析",
      prevStage: null,
    });
  });

  it("has no nextStage at the last stage", () => {
    expect(stageNeighbors(STAGES, "交付")).toEqual({
      nextStage: null,
      prevStage: "验收",
    });
  });

  it("returns both null when the current stage isn't in the planned order (e.g. a subset list)", () => {
    expect(stageNeighbors(["实施", "测试"], "done")).toEqual({
      nextStage: null,
      prevStage: null,
    });
  });

  it("respects a plannedStages subset (e.g. a hotfix's 实施→测试 only)", () => {
    expect(stageNeighbors(["实施", "测试"], "实施")).toEqual({
      nextStage: "测试",
      prevStage: null,
    });
  });
});

describe("canEscalateWorkItem — no fake button when there's no sprint to escalate against", () => {
  it("is true when the item has a sprint", () => {
    expect(canEscalateWorkItem({ id: "sprint_1" })).toBe(true);
  });

  it("is false when the item has no sprint", () => {
    expect(canEscalateWorkItem(null)).toBe(false);
    expect(canEscalateWorkItem(undefined)).toBe(false);
  });
});
