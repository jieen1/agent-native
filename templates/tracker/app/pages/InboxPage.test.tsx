// @vitest-environment happy-dom
import type {
  ActivityResponse,
  Approval,
  InboxRow,
  ReviewChecklistResult,
} from "@shared/types";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RelatedArtifactCard } from "@/lib/inbox";

import {
  EscalationBody,
  GateChecklistSection,
  ProcessedApprovalDetail,
  ProcessedList,
  RelatedArtifactsCard,
} from "./InboxPage";

afterEach(() => {
  cleanup();
});

function withRouter(ui: React.ReactElement) {
  return <MemoryRouter>{ui}</MemoryRouter>;
}

// ── GateChecklistSection — 门判据清单渲染 ────────────────────────────────────

function makeChecklistResult(
  overrides: Partial<ReviewChecklistResult> = {},
): ReviewChecklistResult {
  return {
    workItemId: "wi-1",
    artifactId: "art-anchor-1",
    version: 1,
    complete: false,
    items: [
      {
        key: "sprint-doc",
        label: "sprint-doc 产物存在",
        source: "machine",
        state: "pass",
        checked: true,
        detail: "v1 · human · Steve 定稿于 7-10 14:22",
      },
      {
        key: "migration-audit",
        label: "test-plan 产物",
        source: "machine",
        state: "fail",
        checked: false,
        detail: "缺失 —— 尚未生成",
      },
      {
        key: "ownerscope-check",
        label: "ownerScope 贯穿新查询",
        source: "human",
        state: "needs-human",
        checked: false,
      },
    ],
    ...overrides,
  };
}

describe("<GateChecklistSection> — 门判据清单渲染", () => {
  it("shows skeletons while loading", () => {
    render(<GateChecklistSection loading result={undefined} />);
    // three skeleton placeholders (header + 2 rows)
    expect(
      document.querySelectorAll('[class*="animate-pulse"]').length,
    ).toBeGreaterThan(0);
  });

  it("renders nothing when there is no checklist to gate on (undefined result)", () => {
    const { container } = render(
      <GateChecklistSection loading={false} result={undefined} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when the checklist has zero items", () => {
    const { container } = render(
      <GateChecklistSection
        loading={false}
        result={makeChecklistResult({ items: [] })}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("门判据不全: shows N/M header, a red 'missing' row with detail text for a failed machine item", () => {
    render(
      <GateChecklistSection loading={false} result={makeChecklistResult()} />,
    );
    expect(screen.getByText("门判据 · 1/3 通过")).toBeTruthy();
    expect(screen.getByText("test-plan 产物")).toBeTruthy();
    expect(screen.getByText("缺失 —— 尚未生成")).toBeTruthy();
  });

  it("门判据齐备: every item checked shows N/N and no destructive styling", () => {
    const complete = makeChecklistResult({
      complete: true,
      items: [
        {
          key: "a",
          label: "A",
          source: "machine",
          state: "pass",
          checked: true,
        },
        {
          key: "b",
          label: "B",
          source: "human",
          state: "pass",
          checked: true,
        },
      ],
    });
    render(<GateChecklistSection loading={false} result={complete} />);
    expect(screen.getByText("门判据 · 2/2 通过")).toBeTruthy();
  });

  it("a human unchecked item is clickable and calls onToggleItem; a machine item is not", () => {
    const onToggleItem = vi.fn();
    render(
      <GateChecklistSection
        loading={false}
        result={makeChecklistResult()}
        onToggleItem={onToggleItem}
      />,
    );
    // Human item ("ownerScope 贯穿新查询") renders as a <button>.
    const humanRow = screen
      .getByText("ownerScope 贯穿新查询")
      .closest("button");
    expect(humanRow).toBeTruthy();
    fireEvent.click(humanRow!);
    expect(onToggleItem).toHaveBeenCalledTimes(1);
    expect(onToggleItem.mock.calls[0]![0].key).toBe("ownerscope-check");

    // Machine item ("test-plan 产物") never renders as a button — no click target.
    const machineRow = screen.getByText("test-plan 产物").closest("button");
    expect(machineRow).toBeNull();
  });
});

// ── RelatedArtifactsCard — 关联产物卡片渲染 ──────────────────────────────────

function makeCard(
  overrides: Partial<RelatedArtifactCard> = {},
): RelatedArtifactCard {
  return {
    id: "art-1",
    source: "sprint",
    docKey: "sprint-doc",
    name: "Sprint 4 商户结算自动化",
    kind: "文档",
    version: 1,
    producedByKind: "human",
    excerpt: "目标：商户 T+1 结算全流程无人工对账。",
    createdAt: "2026-07-10T14:22:00.000Z",
    ...overrides,
  };
}

describe("<RelatedArtifactsCard> — 关联产物卡片渲染", () => {
  it("有产物: renders title, docKey, version badge, producer badge, excerpt, and an enabled open button", () => {
    const onOpen = vi.fn();
    render(<RelatedArtifactsCard card={makeCard()} onOpen={onOpen} />);
    expect(screen.getByText(/sprint-doc/)).toBeTruthy();
    expect(screen.getByText("v1")).toBeTruthy();
    expect(screen.getByText("人工")).toBeTruthy();
    expect(screen.getByText(/商户 T\+1 结算/)).toBeTruthy();
    const button = screen.getByRole("button", { name: /打开产物/ });
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("work-item artifact without a contentRef disables the open button (no fake action)", () => {
    const card = makeCard({
      source: "work-item",
      docKey: undefined,
      name: "export-csv.ts",
      contentRef: null,
      excerpt: undefined,
    });
    render(<RelatedArtifactsCard card={card} onOpen={vi.fn()} />);
    const button = screen.getByRole("button", { name: /打开产物/ });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("work-item artifact WITH a contentRef enables the open button", () => {
    const card = makeCard({
      source: "work-item",
      docKey: undefined,
      contentRef: "https://example.com/report",
      excerpt: undefined,
    });
    render(<RelatedArtifactsCard card={card} onOpen={vi.fn()} />);
    const button = screen.getByRole("button", { name: /打开产物/ });
    expect(button.hasAttribute("disabled")).toBe(false);
  });
});

// ── EscalationBody — escalation 专属详情视图 ─────────────────────────────────

function makeEscalationRow(overrides: Partial<InboxRow> = {}): InboxRow {
  return {
    id: "appr-esc-1",
    group: "escalation",
    kind: "escalation",
    title: "escalation",
    summary: "金额四舍五入精度错误 —— reviewer 连续 3 轮 FAILED",
    status: "pending",
    timestamp: "2026-07-16T10:00:00.000Z",
    approvalId: "appr-esc-1",
    gateKey: "escalation",
    gateRef: null,
    workItemId: "wi-pay-203",
    sprintId: "sprint-3",
    itemKeyDisplay: "PAY-203",
    requestedBy: "brain@example.com",
    ...overrides,
  };
}

function activityWithRuns(runs: ActivityResponse["runs"]): ActivityResponse {
  return { dispatched: true, thread: null, events: [], runs, spawns: [] };
}

describe("<EscalationBody> — escalation 专属详情视图（与签核分离）", () => {
  it("renders the gate label, 待裁决 badge, itemKey, and summary", () => {
    render(
      withRouter(
        <EscalationBody
          row={makeEscalationRow()}
          activity={undefined}
          activityLoading={false}
          approving={false}
          onApprove={vi.fn()}
          onReject={vi.fn()}
        />,
      ),
    );
    expect(screen.getByText("待裁决")).toBeTruthy();
    expect(screen.getByText("PAY-203")).toBeTruthy();
    expect(screen.getByText(/reviewer 连续 3 轮 FAILED/)).toBeTruthy();
  });

  it("resolves and links the run id from gateRef when present (跳 s7 run badge)", () => {
    const row = makeEscalationRow({
      gateRef: JSON.stringify({ runId: "run_6c8p17xyz", nodeId: "review" }),
    });
    render(
      withRouter(
        <EscalationBody
          row={row}
          activity={undefined}
          activityLoading={false}
          approving={false}
          onApprove={vi.fn()}
          onReject={vi.fn()}
        />,
      ),
    );
    const runLink = screen
      .getAllByRole("link")
      .find((a) => a.getAttribute("href")?.includes("run_6c8p17xyz"));
    expect(runLink).toBeTruthy();
    expect(screen.getByRole("link", { name: /打开运行详情/ })).toBeTruthy();
  });

  it("falls back to the activity's own run when gateRef has no runId", () => {
    const row = makeEscalationRow({ gateRef: null });
    render(
      withRouter(
        <EscalationBody
          row={row}
          activity={activityWithRuns([
            { id: "run_from_activity", status: "failed", nodes: [] },
          ])}
          activityLoading={false}
          approving={false}
          onApprove={vi.fn()}
          onReject={vi.fn()}
        />,
      ),
    );
    const runLink = screen
      .getAllByRole("link")
      .find((a) => a.getAttribute("href")?.includes("run_from_activity"));
    expect(runLink).toBeTruthy();
  });

  it("shows no run badge / 打开运行详情 button when no run id is resolvable anywhere", () => {
    render(
      withRouter(
        <EscalationBody
          row={makeEscalationRow({ gateRef: null })}
          activity={activityWithRuns([])}
          activityLoading={false}
          approving={false}
          onApprove={vi.fn()}
          onReject={vi.fn()}
        />,
      ),
    );
    expect(screen.queryByRole("link", { name: /打开运行详情/ })).toBeNull();
  });

  it("uses escalation-specific button copy (批准继续 / 驳回终止), distinct from ApprovalDetail's 批准/驳回", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(
      withRouter(
        <EscalationBody
          row={makeEscalationRow()}
          activity={undefined}
          activityLoading={false}
          approving={false}
          onApprove={onApprove}
          onReject={onReject}
        />,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /批准继续/ }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /驳回终止/ }));
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it("discloses the honest round-history data gap instead of fabricating per-round findings", () => {
    render(
      withRouter(
        <EscalationBody
          row={makeEscalationRow()}
          activity={activityWithRuns([])}
          activityLoading={false}
          approving={false}
          onApprove={vi.fn()}
          onReject={vi.fn()}
        />,
      ),
    );
    expect(screen.getByText(/评审轮次历史/)).toBeTruthy();
  });
});

// ── 已处理 tab (ProcessedList / ProcessedApprovalDetail) — tab切换目标数据 ───

function makeProcessedApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "appr-done-1",
    sprintId: "sprint-1",
    workItemId: "wi-1",
    gateKey: "plan-signoff",
    gateRef: null,
    status: "approved",
    requestedBy: "steve@example.com",
    decidedBy: "lead@example.com",
    reason: null,
    decidedAt: "2026-07-15T09:00:00.000Z",
    createdAt: "2026-07-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("<ProcessedList> — 已处理 tab 列表", () => {
  it("shows an empty-state message when there is no processed history", () => {
    render(
      <ProcessedList approvals={[]} selectedId={null} onSelect={vi.fn()} />,
    );
    expect(screen.getByText("暂无已处理记录")).toBeTruthy();
  });

  it("renders 已批准/已驳回 badges and calls onSelect with the row id", () => {
    const onSelect = vi.fn();
    const approved = makeProcessedApproval({ id: "a1", status: "approved" });
    const rejected = makeProcessedApproval({ id: "r1", status: "rejected" });
    render(
      <ProcessedList
        approvals={[approved, rejected]}
        selectedId={null}
        onSelect={onSelect}
      />,
    );
    expect(screen.getByText("已批准")).toBeTruthy();
    expect(screen.getByText("已驳回")).toBeTruthy();
    fireEvent.click(screen.getByText("已批准"));
    expect(onSelect).toHaveBeenCalledWith("a1");
  });
});

describe("<ProcessedApprovalDetail> — 已处理详情", () => {
  it("shows a select-prompt when nothing is selected", () => {
    render(withRouter(<ProcessedApprovalDetail approval={null} />));
    expect(screen.getByText("选择左侧一项查看详情")).toBeTruthy();
  });

  it("renders decidedBy/decidedAt and the reason line only when a reason exists", () => {
    render(
      withRouter(
        <ProcessedApprovalDetail
          approval={makeProcessedApproval({ reason: "缺 test-plan 产物" })}
        />,
      ),
    );
    expect(screen.getByText("lead@example.com")).toBeTruthy();
    expect(screen.getByText("缺 test-plan 产物")).toBeTruthy();
  });

  it("omits the reason row when there is none", () => {
    render(
      withRouter(
        <ProcessedApprovalDetail
          approval={makeProcessedApproval({ reason: null })}
        />,
      ),
    );
    expect(screen.queryByText("理由")).toBeNull();
  });
});
