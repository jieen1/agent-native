import { describe, expect, it } from "vitest";

import { deriveBurndown } from "../sprint-burndown.js";

describe("deriveBurndown — honest empty states, no fabricated points", () => {
  it("returns no-items for an empty sprint", () => {
    const r = deriveBurndown({ items: [], stages: [], startDate: "2026-07-01" });
    expect(r.points).toHaveLength(0);
    expect(r.emptyReason).toBe("no-items");
  });

  it("returns no-start-date when startDate is missing", () => {
    const r = deriveBurndown({
      items: [{ id: "i1", status: "open", updatedAt: "2026-07-01T00:00:00Z" }],
      stages: [],
      startDate: null,
    });
    expect(r.emptyReason).toBe("no-start-date");
  });

  it("returns too-new when start and now are the same day", () => {
    const r = deriveBurndown({
      items: [{ id: "i1", status: "open", updatedAt: "2026-07-10T00:00:00Z" }],
      stages: [],
      startDate: "2026-07-10",
      now: new Date("2026-07-10T12:00:00Z"),
    });
    expect(r.emptyReason).toBe("too-new");
  });

  it("returns too-long when the span exceeds 120 days", () => {
    const r = deriveBurndown({
      items: [{ id: "i1", status: "open", updatedAt: "2026-07-10T00:00:00Z" }],
      stages: [],
      startDate: "2026-01-01",
      now: new Date("2027-07-10T00:00:00Z"),
    });
    expect(r.emptyReason).toBe("too-long");
  });

  it("counts an item delivered via its 交付 stage completedAt", () => {
    const r = deriveBurndown({
      items: [
        { id: "i1", status: "running", updatedAt: "2026-07-05T00:00:00Z" },
        { id: "i2", status: "running", updatedAt: "2026-07-05T00:00:00Z" },
      ],
      stages: [
        { workItemId: "i1", stageName: "交付", completedAt: "2026-07-02T12:00:00Z" },
      ],
      startDate: "2026-07-01",
      now: new Date("2026-07-04T00:00:00Z"),
    });
    expect(r.emptyReason).toBeNull();
    expect(r.total).toBe(2);
    // Day 1 (Jul 01): nothing delivered yet → remaining 2
    expect(r.points[0].remaining).toBe(2);
    // Day 2 (Jul 02): i1 delivered → remaining 1
    expect(r.points[1].remaining).toBe(1);
    // Day 3 (Jul 03): still 1
    expect(r.points[2].remaining).toBe(1);
  });

  it("falls back to item.updatedAt for terminal done/closed items without a 交付 stage", () => {
    const r = deriveBurndown({
      items: [
        { id: "i1", status: "done", updatedAt: "2026-07-02T12:00:00Z" },
        { id: "i2", status: "open", updatedAt: "2026-07-05T00:00:00Z" },
      ],
      stages: [],
      startDate: "2026-07-01",
      now: new Date("2026-07-04T00:00:00Z"),
    });
    expect(r.emptyReason).toBeNull();
    expect(r.points[1].remaining).toBe(1); // i1 delivered on Jul 02
  });
});
