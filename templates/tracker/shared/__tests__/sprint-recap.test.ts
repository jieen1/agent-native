import { describe, expect, it } from "vitest";

import {
  buildSprintRecap,
  renderSprintRecapMarkdown,
  type RecapApprovalRow,
  type RecapCommentRow,
  type RecapRunRow,
  type RecapStageRow,
} from "../sprint-recap.js";

const EMPTY = { approvals: [], comments: [], stages: [], runs: [] };

describe("buildSprintRecap — human-intervention timeline (no fabrication)", () => {
  it("reports noInterventions honestly when all records are empty", () => {
    const r = buildSprintRecap(EMPTY);
    expect(r.noInterventions).toBe(true);
    expect(r.entries).toHaveLength(0);
    expect(r.counts).toEqual({ approval: 0, correction: 0, escalation: 0 });
  });

  it("classifies an approved approval as an approval entry", () => {
    const approvals: RecapApprovalRow[] = [
      {
        id: "apr_1",
        gateKey: "plan-signoff",
        status: "approved",
        requestedBy: "a@x.com",
        decidedBy: "b@x.com",
        reason: "ok",
        createdAt: "2026-07-01T10:00:00Z",
        decidedAt: "2026-07-01T11:00:00Z",
      },
    ];
    const r = buildSprintRecap({ ...EMPTY, approvals });
    expect(r.counts.approval).toBe(1);
    expect(r.entries[0].source).toBe("approval:apr_1");
    expect(r.entries[0].who).toBe("b@x.com");
  });

  it("classifies a rejected approval as an escalation", () => {
    const approvals: RecapApprovalRow[] = [
      {
        id: "apr_2",
        gateKey: "ui-signoff",
        status: "rejected",
        requestedBy: "a@x.com",
        decidedBy: "b@x.com",
        reason: "missing states",
        createdAt: "2026-07-01T10:00:00Z",
        decidedAt: "2026-07-01T11:00:00Z",
      },
    ];
    const r = buildSprintRecap({ ...EMPTY, approvals });
    expect(r.counts.escalation).toBe(1);
  });

  it("only counts HUMAN comments (not agent comments)", () => {
    const comments: RecapCommentRow[] = [
      {
        id: "cmt_h",
        authorKind: "human",
        authorName: "Human",
        body: "change direction",
        createdAt: "2026-07-02T10:00:00Z",
      },
      {
        id: "cmt_a",
        authorKind: "agent",
        authorName: "Agent",
        body: "auto note",
        createdAt: "2026-07-02T11:00:00Z",
      },
    ];
    const r = buildSprintRecap({ ...EMPTY, comments });
    expect(r.counts.correction).toBe(1);
    expect(r.entries[0].source).toBe("comment:cmt_h");
  });

  it("counts 已驳回 stages as escalations", () => {
    const stages: RecapStageRow[] = [
      {
        id: "stg_1",
        stageName: "验收",
        stageStatus: "已驳回",
        verdictReason: "failed tests",
        updatedAt: "2026-07-03T10:00:00Z",
      },
      {
        id: "stg_2",
        stageName: "测试",
        stageStatus: "已完成",
        verdictReason: null,
        updatedAt: "2026-07-03T11:00:00Z",
      },
    ];
    const r = buildSprintRecap({ ...EMPTY, stages });
    expect(r.counts.escalation).toBe(1);
    expect(r.entries[0].source).toBe("stage:stg_1");
  });

  it("counts superseded runs as course corrections", () => {
    const runs: RecapRunRow[] = [
      { id: "run_1", superseded: 1, createdAt: "2026-07-04T10:00:00Z" },
      { id: "run_2", superseded: 0, createdAt: "2026-07-04T11:00:00Z" },
    ];
    const r = buildSprintRecap({ ...EMPTY, runs });
    expect(r.counts.correction).toBe(1);
    expect(r.entries[0].source).toBe("run:run_1");
  });

  it("orders entries chronologically", () => {
    const r = buildSprintRecap({
      approvals: [
        {
          id: "apr_late",
          gateKey: "g",
          status: "approved",
          requestedBy: "a",
          decidedBy: "b",
          reason: null,
          createdAt: "2026-07-05T10:00:00Z",
          decidedAt: null,
        },
      ],
      comments: [
        {
          id: "cmt_early",
          authorKind: "human",
          authorName: "H",
          body: "x",
          createdAt: "2026-07-01T10:00:00Z",
        },
      ],
      stages: [],
      runs: [],
    });
    expect(r.entries[0].source).toBe("comment:cmt_early");
    expect(r.entries[1].source).toBe("approval:apr_late");
  });
});

describe("renderSprintRecapMarkdown", () => {
  it("renders the honest no-interventions message", () => {
    const md = renderSprintRecapMarkdown("Sprint X", buildSprintRecap(EMPTY));
    expect(md).toContain("无人工干预记录");
  });

  it("renders a table with source citations", () => {
    const recap = buildSprintRecap({
      approvals: [
        {
          id: "apr_1",
          gateKey: "plan-signoff",
          status: "approved",
          requestedBy: "a",
          decidedBy: "b",
          reason: null,
          createdAt: "2026-07-01T10:00:00Z",
          decidedAt: null,
        },
      ],
      comments: [],
      stages: [],
      runs: [],
    });
    const md = renderSprintRecapMarkdown("Sprint X", recap);
    expect(md).toContain("approval:apr_1");
    expect(md).toContain("| 时间 |");
  });
});
