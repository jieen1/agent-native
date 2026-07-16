import type {
  Approval,
  Artifact,
  InboxGroups,
  InboxRow,
  SprintArtifact,
} from "@shared/types";
import { describe, expect, it } from "vitest";

import {
  INBOX_GROUP_ORDER,
  canEscalate,
  combineRelatedArtifacts,
  findInboxRow,
  flattenInboxRows,
  formatBadgeCount,
  formatRelativeTime,
  isApproveGateDisabled,
  isGroupEmpty,
  isInboxEmpty,
  latestSprintArtifactCards,
  parseGateRef,
  pickDefaultSelection,
  previousStage,
  processedApprovals,
  resolveEscalationRunId,
  totalPendingCount,
  workItemArtifactCards,
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

// ── S5 additions ─────────────────────────────────────────────────────────────

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "appr-1",
    sprintId: "sprint-1",
    workItemId: null,
    gateKey: "plan-signoff",
    gateRef: null,
    status: "pending",
    requestedBy: "steve@example.com",
    decidedBy: null,
    reason: null,
    decidedAt: null,
    createdAt: "2026-07-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("processedApprovals — 已处理 tab data source", () => {
  it("excludes pending, keeps approved/rejected", () => {
    const rows = [
      makeApproval({ id: "p1", status: "pending" }),
      makeApproval({ id: "a1", status: "approved" }),
      makeApproval({ id: "r1", status: "rejected" }),
    ];
    expect(processedApprovals(rows).map((a) => a.id)).toEqual(["a1", "r1"]);
  });

  it("returns an empty array for undefined input", () => {
    expect(processedApprovals(undefined)).toEqual([]);
  });
});

describe("parseGateRef", () => {
  it("returns null for null/undefined/empty input", () => {
    expect(parseGateRef(null)).toBeNull();
    expect(parseGateRef(undefined)).toBeNull();
    expect(parseGateRef("")).toBeNull();
  });

  it("returns null for malformed JSON — never throws", () => {
    expect(parseGateRef("{not json")).toBeNull();
  });

  it("returns null for valid JSON with neither runId nor nodeId", () => {
    expect(parseGateRef(JSON.stringify({ foo: "bar" }))).toBeNull();
  });

  it("parses runId + nodeId", () => {
    expect(
      parseGateRef(JSON.stringify({ runId: "run_1", nodeId: "review" })),
    ).toEqual({ runId: "run_1", nodeId: "review" });
  });

  it("parses runId alone", () => {
    expect(parseGateRef(JSON.stringify({ runId: "run_1" }))).toEqual({
      runId: "run_1",
    });
  });
});

describe("resolveEscalationRunId", () => {
  it("prefers the gateRef's runId over any activity run", () => {
    expect(
      resolveEscalationRunId(JSON.stringify({ runId: "run_from_gate" }), [
        { id: "run_from_activity" },
      ]),
    ).toBe("run_from_gate");
  });

  it("falls back to the first activity run when gateRef has none", () => {
    expect(resolveEscalationRunId(null, [{ id: "run_from_activity" }])).toBe(
      "run_from_activity",
    );
  });

  it("returns null when neither source has a run id", () => {
    expect(resolveEscalationRunId(null, undefined)).toBeNull();
    expect(resolveEscalationRunId(null, [])).toBeNull();
  });
});

describe("isApproveGateDisabled — 门判据驱动的批准按钮", () => {
  it("never gates a sprint-level signoff with no work item (no checklist applies)", () => {
    expect(
      isApproveGateDisabled({
        hasWorkItem: false,
        checklistLoading: false,
        checklistComplete: null,
      }),
    ).toBe(false);
  });

  it("disables while the checklist is loading", () => {
    expect(
      isApproveGateDisabled({
        hasWorkItem: true,
        checklistLoading: true,
        checklistComplete: null,
      }),
    ).toBe(true);
  });

  it("disables when the checklist is incomplete", () => {
    expect(
      isApproveGateDisabled({
        hasWorkItem: true,
        checklistLoading: false,
        checklistComplete: false,
      }),
    ).toBe(true);
  });

  it("enables once every checklist item is checked", () => {
    expect(
      isApproveGateDisabled({
        hasWorkItem: true,
        checklistLoading: false,
        checklistComplete: true,
      }),
    ).toBe(false);
  });
});

function makeSprintArtifact(
  overrides: Partial<SprintArtifact> = {},
): SprintArtifact {
  return {
    id: "art-1",
    sprintId: "sprint-1",
    docKey: "sprint-doc",
    kind: "文档",
    name: "Sprint 4 商户结算自动化",
    version: 1,
    supersedes: null,
    producedByKind: "human",
    content: "目标：商户 T+1 结算全流程无人工对账。",
    contentRef: null,
    createdAt: "2026-07-10T14:22:00.000Z",
    ...overrides,
  };
}

describe("latestSprintArtifactCards", () => {
  it("returns an empty array for undefined input", () => {
    expect(latestSprintArtifactCards(undefined)).toEqual([]);
  });

  it("picks the latest (last) version per docKey and carries an excerpt", () => {
    const v1 = makeSprintArtifact({ id: "v1", version: 1, content: "旧版" });
    const v2 = makeSprintArtifact({ id: "v2", version: 2, content: "新版" });
    const cards = latestSprintArtifactCards({ "sprint-doc": [v1, v2] });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.id).toBe("v2");
    expect(cards[0]!.version).toBe(2);
    expect(cards[0]!.excerpt).toBe("新版");
  });

  it("omits excerpt for an empty-content artifact instead of an empty string", () => {
    const cards = latestSprintArtifactCards({
      "test-plan": [makeSprintArtifact({ content: "" })],
    });
    expect(cards[0]!.excerpt).toBeUndefined();
  });

  it("renders multiple docKeys, each as its own card", () => {
    const cards = latestSprintArtifactCards({
      "sprint-doc": [makeSprintArtifact({ id: "sd1" })],
      "test-plan": [makeSprintArtifact({ id: "tp1", docKey: "test-plan" })],
    });
    expect(cards.map((c) => c.docKey).sort()).toEqual([
      "sprint-doc",
      "test-plan",
    ]);
  });
});

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "wia-1",
    workItemId: "wi-1",
    stageId: "stage-1",
    stageName: "实施",
    kind: "code",
    name: "export-csv.ts",
    version: 1,
    contentRef: "",
    producedByKind: "agent",
    supersedes: null,
    createdAt: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("workItemArtifactCards", () => {
  it("returns an empty array for undefined input", () => {
    expect(workItemArtifactCards(undefined)).toEqual([]);
  });

  it("flattens every stage's artifacts, newest first", () => {
    const older = makeArtifact({
      id: "a1",
      createdAt: "2026-07-14T00:00:00.000Z",
    });
    const newer = makeArtifact({
      id: "a2",
      createdAt: "2026-07-16T00:00:00.000Z",
    });
    const cards = workItemArtifactCards({ 实施: [older], 测试: [newer] });
    expect(cards.map((c) => c.id)).toEqual(["a2", "a1"]);
  });

  it("never fabricates an excerpt — work item artifacts have no content field", () => {
    const cards = workItemArtifactCards({ 实施: [makeArtifact()] });
    expect(cards[0]!.excerpt).toBeUndefined();
  });

  it("carries contentRef through when present, null when blank", () => {
    const withRef = workItemArtifactCards({
      实施: [makeArtifact({ contentRef: "https://example.com/report" })],
    });
    expect(withRef[0]!.contentRef).toBe("https://example.com/report");
    const withoutRef = workItemArtifactCards({
      实施: [makeArtifact({ contentRef: "" })],
    });
    expect(withoutRef[0]!.contentRef).toBeNull();
  });
});

describe("combineRelatedArtifacts", () => {
  it("puts sprint cards before work-item cards and caps the total", () => {
    const sprintCards = latestSprintArtifactCards({
      "sprint-doc": [makeSprintArtifact()],
    });
    const workItemCards = workItemArtifactCards({
      实施: [
        makeArtifact({ id: "a1" }),
        makeArtifact({ id: "a2" }),
        makeArtifact({ id: "a3" }),
        makeArtifact({ id: "a4" }),
        makeArtifact({ id: "a5" }),
      ],
    });
    const combined = combineRelatedArtifacts(sprintCards, workItemCards);
    expect(combined).toHaveLength(4);
    expect(combined[0]!.source).toBe("sprint");
  });

  it("returns an empty array when there is nothing on either side", () => {
    expect(combineRelatedArtifacts([], [])).toEqual([]);
  });
});
