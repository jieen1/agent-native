import { describe, expect, it } from "vitest";

import {
  computeBurndown,
  medianStageDurationsMinutes,
} from "../sprint-metrics.js";

describe("computeBurndown — S6 度量摘要燃尽微图 (honest, no fabricated points)", () => {
  it("returns null for a sprint with zero items", () => {
    expect(computeBurndown([], [], "2026-07-01")).toBeNull();
  });

  it("returns null when the sprint has no startDate (nothing to anchor the x-axis on)", () => {
    const items = [
      { id: "i1", status: "open", updatedAt: "2026-07-01T00:00:00Z" },
    ];
    expect(computeBurndown(items, [], null)).toBeNull();
  });

  it("returns null when start and now are the same day (no trend to draw)", () => {
    const items = [
      { id: "i1", status: "open", updatedAt: "2026-07-10T00:00:00Z" },
    ];
    const now = new Date("2026-07-10T12:00:00Z");
    expect(computeBurndown(items, [], "2026-07-10", now)).toBeNull();
  });

  it("returns null when the span exceeds the sanity cap", () => {
    const items = [
      { id: "i1", status: "open", updatedAt: "2026-07-10T00:00:00Z" },
    ];
    const now = new Date("2027-07-10T00:00:00Z");
    expect(computeBurndown(items, [], "2026-01-01", now)).toBeNull();
  });

  it("counts an item delivered via its 交付 stage's completedAt", () => {
    const items = [
      { id: "i1", status: "running", updatedAt: "2026-07-05T00:00:00Z" },
      { id: "i2", status: "running", updatedAt: "2026-07-05T00:00:00Z" },
    ];
    const stages = [
      {
        workItemId: "i1",
        stageName: "交付",
        completedAt: "2026-07-03T00:00:00Z",
      },
    ];
    const now = new Date("2026-07-05T00:00:00Z");
    const result = computeBurndown(items, stages, "2026-07-01", now);
    expect(result).not.toBeNull();
    expect(result!.total).toBe(2);
    // Day 0 (07-01): nothing delivered yet → remaining 2.
    expect(result!.points[0]).toEqual({ date: "07-01", remaining: 2 });
    // Day 2 (07-03): i1 delivered by end of day → remaining 1.
    expect(result!.points[2]).toEqual({ date: "07-03", remaining: 1 });
    // Final day (07-05): still only i1 delivered → remaining 1.
    expect(result!.points[result!.points.length - 1]).toEqual({
      date: "07-05",
      remaining: 1,
    });
  });

  it("falls back to item.updatedAt for a done item with no 交付 stage row", () => {
    const items = [
      { id: "i1", status: "done", updatedAt: "2026-07-02T00:00:00Z" },
    ];
    const now = new Date("2026-07-04T00:00:00Z");
    const result = computeBurndown(items, [], "2026-07-01", now);
    expect(result!.points[0]!.remaining).toBe(1);
    expect(result!.points[1]!.remaining).toBe(0); // 07-02 onward: delivered
  });

  it("never delivers an item that is neither done/closed nor has a 交付 stage", () => {
    const items = [
      { id: "i1", status: "failed", updatedAt: "2026-07-02T00:00:00Z" },
    ];
    const now = new Date("2026-07-04T00:00:00Z");
    const result = computeBurndown(items, [], "2026-07-01", now);
    expect(result!.points.every((p) => p.remaining === 1)).toBe(true);
  });
});

describe("medianStageDurationsMinutes — S6 度量摘要中位环节耗时 (real tracker_stages rows only)", () => {
  it("returns an empty array when no stage has both startedAt and completedAt", () => {
    const stages = [
      { stageName: "实施", startedAt: null, completedAt: null },
      {
        stageName: "测试",
        startedAt: "2026-07-01T00:00:00Z",
        completedAt: null,
      },
    ];
    expect(medianStageDurationsMinutes(stages)).toEqual([]);
  });

  it("computes the median for a single stage with several samples", () => {
    const stages = [
      {
        stageName: "实施",
        startedAt: "2026-07-01T00:00:00Z",
        completedAt: "2026-07-01T00:10:00Z",
      }, // 10m
      {
        stageName: "实施",
        startedAt: "2026-07-02T00:00:00Z",
        completedAt: "2026-07-02T00:20:00Z",
      }, // 20m
      {
        stageName: "实施",
        startedAt: "2026-07-03T00:00:00Z",
        completedAt: "2026-07-03T00:30:00Z",
      }, // 30m
    ];
    expect(medianStageDurationsMinutes(stages)).toEqual([
      { stageName: "实施", minutes: 20 },
    ]);
  });

  it("orders results by the pipeline's stage order, not input order", () => {
    const stages = [
      {
        stageName: "交付",
        startedAt: "2026-07-01T00:00:00Z",
        completedAt: "2026-07-01T00:05:00Z",
      },
      {
        stageName: "分析",
        startedAt: "2026-07-01T00:00:00Z",
        completedAt: "2026-07-01T00:15:00Z",
      },
    ];
    expect(medianStageDurationsMinutes(stages).map((d) => d.stageName)).toEqual(
      ["分析", "交付"],
    );
  });

  it("ignores a malformed row where completedAt precedes startedAt", () => {
    const stages = [
      {
        stageName: "测试",
        startedAt: "2026-07-02T00:00:00Z",
        completedAt: "2026-07-01T00:00:00Z",
      },
    ];
    expect(medianStageDurationsMinutes(stages)).toEqual([]);
  });
});
