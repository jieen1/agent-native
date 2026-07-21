import { describe, expect, it } from "vitest";

import type { TrackerWorkItem } from "../../../shared/types.js";

function calcSprintProgress(items: TrackerWorkItem[]) {
  const total = items.length;
  const delivered = items.filter((i) => i.currentStageName === "交付").length;
  const pct = total === 0 ? 0 : Math.round((delivered / total) * 100);
  return { total, delivered, pct };
}

describe("Sprint progress", () => {
  it("returns 0% with no items", () => {
    expect(calcSprintProgress([]).pct).toBe(0);
  });
  it("returns 100% when all delivered", () => {
    const items = [
      { currentStageName: "交付" } as any,
      { currentStageName: "交付" } as any,
    ];
    expect(calcSprintProgress(items).pct).toBe(100);
  });
  it("calculates partial progress correctly", () => {
    const items = [
      { currentStageName: "交付" } as any,
      { currentStageName: "实施" } as any,
      { currentStageName: "测试" } as any,
      { currentStageName: "交付" } as any,
    ];
    expect(calcSprintProgress(items)).toEqual({
      total: 4,
      delivered: 2,
      pct: 50,
    });
  });
  it("handles all non-delivered stages", () => {
    const items = [
      { currentStageName: "分析" } as any,
      { currentStageName: "设计" } as any,
    ];
    expect(calcSprintProgress(items).delivered).toBe(0);
    expect(calcSprintProgress(items).pct).toBe(0);
  });
});
