import type { InboxGroups, InboxRow } from "@shared/types";
import { describe, expect, it } from "vitest";

import {
  INBOX_GROUP_ORDER,
  canEscalate,
  findInboxRow,
  flattenInboxRows,
  formatBadgeCount,
  formatRelativeTime,
  isGroupEmpty,
  isInboxEmpty,
  pickDefaultSelection,
  previousStage,
  totalPendingCount,
} from "../inbox.js";

function makeRow(
  id: string,
  group: InboxRow["group"],
  overrides: Partial<InboxRow> = {},
): InboxRow {
  return {
    id,
    group,
    kind: "test",
    title: `Row ${id}`,
    summary: "",
    status: "pending",
    timestamp: "2026-07-16T00:00:00.000Z",
    ...overrides,
  };
}

function makeGroups(overrides: Partial<InboxGroups> = {}): InboxGroups {
  return {
    signoff: [],
    escalation: [],
    reviewRequest: [],
    failedRouting: [],
    notifications: [],
    ...overrides,
  };
}

describe("flattenInboxRows", () => {
  it("returns an empty array for undefined groups", () => {
    expect(flattenInboxRows(undefined)).toEqual([]);
  });

  it("flattens in the fixed group render order regardless of insertion order", () => {
    const groups = makeGroups({
      failedRouting: [makeRow("f1", "failedRouting")],
      signoff: [makeRow("s1", "signoff")],
      reviewRequest: [makeRow("r1", "reviewRequest")],
      escalation: [makeRow("e1", "escalation")],
    });
    const flat = flattenInboxRows(groups);
    expect(flat.map((r) => r.id)).toEqual(["s1", "r1", "e1", "f1"]);
  });

  it("matches INBOX_GROUP_ORDER length (5 groups, notifications included even if empty)", () => {
    expect(INBOX_GROUP_ORDER).toHaveLength(5);
    expect(INBOX_GROUP_ORDER).toContain("notifications");
  });

  it("preserves within-group order", () => {
    const groups = makeGroups({
      signoff: [makeRow("s1", "signoff"), makeRow("s2", "signoff")],
    });
    expect(flattenInboxRows(groups).map((r) => r.id)).toEqual(["s1", "s2"]);
  });
});

describe("findInboxRow", () => {
  const groups = makeGroups({
    signoff: [makeRow("s1", "signoff")],
    failedRouting: [makeRow("f1", "failedRouting")],
  });

  it("returns null when selectedId is null/undefined", () => {
    expect(findInboxRow(groups, null)).toBeNull();
    expect(findInboxRow(groups, undefined)).toBeNull();
  });

  it("returns null when the id is not present in any group", () => {
    expect(findInboxRow(groups, "does-not-exist")).toBeNull();
  });

  it("finds a row by id across groups", () => {
    expect(findInboxRow(groups, "f1")?.id).toBe("f1");
    expect(findInboxRow(groups, "s1")?.id).toBe("s1");
  });
});

describe("pickDefaultSelection", () => {
  it("returns null when every group is empty", () => {
    expect(pickDefaultSelection(makeGroups())).toBeNull();
  });

  it("picks the first row in group render order, not insertion order", () => {
    const groups = makeGroups({
      failedRouting: [makeRow("f1", "failedRouting")],
      reviewRequest: [makeRow("r1", "reviewRequest")],
    });
    // reviewRequest renders before failedRouting per INBOX_GROUP_ORDER.
    expect(pickDefaultSelection(groups)?.id).toBe("r1");
  });
});

describe("isGroupEmpty / isInboxEmpty", () => {
  it("isGroupEmpty is true for an empty group and false for a non-empty one", () => {
    const groups = makeGroups({ signoff: [makeRow("s1", "signoff")] });
    expect(isGroupEmpty(groups, "signoff")).toBe(false);
    expect(isGroupEmpty(groups, "escalation")).toBe(true);
  });

  it("isInboxEmpty is true only when every group is empty", () => {
    expect(isInboxEmpty(makeGroups())).toBe(true);
    expect(isInboxEmpty(makeGroups({ notifications: [] }))).toBe(true);
    expect(
      isInboxEmpty(
        makeGroups({ failedRouting: [makeRow("f1", "failedRouting")] }),
      ),
    ).toBe(false);
  });
});

describe("canEscalate — real request-approval constraint (sprintId required)", () => {
  it("true for a failedRouting row with a sprintId", () => {
    expect(
      canEscalate(makeRow("f1", "failedRouting", { sprintId: "sprint-1" })),
    ).toBe(true);
  });

  it("false for a failedRouting row without a sprintId — no fake button", () => {
    expect(
      canEscalate(makeRow("f1", "failedRouting", { sprintId: null })),
    ).toBe(false);
    expect(canEscalate(makeRow("f1", "failedRouting", {}))).toBe(false);
  });

  it("false for any non-failedRouting group even with a sprintId", () => {
    expect(
      canEscalate(makeRow("s1", "signoff", { sprintId: "sprint-1" })),
    ).toBe(false);
    expect(
      canEscalate(makeRow("r1", "reviewRequest", { sprintId: "sprint-1" })),
    ).toBe(false);
  });
});

describe("formatBadgeCount", () => {
  it("returns empty string for zero or negative", () => {
    expect(formatBadgeCount(0)).toBe("");
    expect(formatBadgeCount(-1)).toBe("");
  });

  it("returns the exact number under 100", () => {
    expect(formatBadgeCount(1)).toBe("1");
    expect(formatBadgeCount(99)).toBe("99");
  });

  it("caps at 99+", () => {
    expect(formatBadgeCount(100)).toBe("99+");
    expect(formatBadgeCount(1000)).toBe("99+");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-07-16T12:00:00.000Z");

  it("returns em-dash for missing/invalid input", () => {
    expect(formatRelativeTime(null, now)).toBe("—");
    expect(formatRelativeTime(undefined, now)).toBe("—");
    expect(formatRelativeTime("not-a-date", now)).toBe("—");
  });

  it("returns 刚刚 for under a minute (and for future timestamps)", () => {
    expect(formatRelativeTime("2026-07-16T11:59:45.000Z", now)).toBe("刚刚");
    expect(formatRelativeTime("2026-07-16T12:00:05.000Z", now)).toBe("刚刚");
  });

  it("returns minutes for under an hour", () => {
    expect(formatRelativeTime("2026-07-16T11:55:00.000Z", now)).toBe(
      "5 分钟前",
    );
  });

  it("returns hours for under a day", () => {
    expect(formatRelativeTime("2026-07-16T09:00:00.000Z", now)).toBe(
      "3 小时前",
    );
  });

  it("returns days for under a week", () => {
    expect(formatRelativeTime("2026-07-14T12:00:00.000Z", now)).toBe("2 天前");
  });

  it("falls back to a date string at a week or more", () => {
    expect(formatRelativeTime("2026-07-01T12:00:00.000Z", now)).toBe(
      "2026-07-01",
    );
  });
});

describe("previousStage", () => {
  it("returns the prior stage in the 7-stage ladder", () => {
    expect(previousStage("测试")).toBe("实施");
    expect(previousStage("交付")).toBe("验收");
    expect(previousStage("分析")).toBe("待办");
  });

  it("returns null at the first stage (nothing before 待办)", () => {
    expect(previousStage("待办")).toBeNull();
  });

  it("returns null for an unrecognized or missing stage name — never guesses", () => {
    expect(previousStage("not-a-stage")).toBeNull();
    expect(previousStage(null)).toBeNull();
    expect(previousStage(undefined)).toBeNull();
    expect(previousStage("")).toBeNull();
  });
});

describe("totalPendingCount", () => {
  it("returns 0 for undefined counts", () => {
    expect(totalPendingCount(undefined)).toBe(0);
  });

  it("passes through counts.total", () => {
    expect(
      totalPendingCount({
        signoff: 1,
        escalation: 2,
        reviewRequest: 3,
        failedRouting: 4,
        notifications: 0,
        total: 10,
      }),
    ).toBe(10);
  });
});
