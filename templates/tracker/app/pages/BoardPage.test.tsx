// @vitest-environment happy-dom
import { DndContext } from "@dnd-kit/core";
import type { ActivityResponse, TrackerWorkItem } from "@shared/types";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MiniStageStepper, WorkItemCard } from "./BoardPage";

const mockUseActivity = vi.fn();
const mockMutate = vi.fn();

vi.mock("@/hooks/use-tracker", () => ({
  useActivity: (...args: unknown[]) => mockUseActivity(...args),
  useDispatch: () => ({ mutate: mockMutate, isPending: false }),
  useRollbackStage: () => ({ mutate: mockMutate, isPending: false }),
  useRequestApproval: () => ({ mutate: mockMutate, isPending: false }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockUseActivity.mockReturnValue({ data: undefined, isLoading: false });
});

function withProviders(ui: React.ReactElement) {
  return (
    <MemoryRouter>
      <DndContext>{ui}</DndContext>
    </MemoryRouter>
  );
}

function baseItem(overrides: Partial<TrackerWorkItem> = {}): TrackerWorkItem {
  return {
    id: "wi-1",
    projectId: "proj-1",
    sprintId: "sprint-1",
    itemKey: "PAY-201",
    type: "requirement",
    title: "账单导出 CSV 接口",
    description: "",
    status: "open",
    priority: 1,
    risk: "medium",
    tags: [],
    executionMode: "manual",
    currentStageName: "实施",
    plannedStages: [],
    branch: null,
    orchestratorThreadId: null,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

// ── MiniStageStepper (issue #8) ──────────────────────────────────────────────

describe("<MiniStageStepper>", () => {
  it("renders one dot per stage in the sequence", () => {
    const { container } = render(
      <MiniStageStepper
        sequence={["待办", "分析", "设计", "实施", "测试", "验收", "交付"]}
        currentStageName="实施"
        status="running"
      />,
    );
    expect(container.querySelectorAll("span > span").length).toBe(7);
  });

  it("renders a subset sequence when plannedStages is a real subset", () => {
    const { container } = render(
      <MiniStageStepper
        sequence={["实施", "测试"]}
        currentStageName="实施"
        status="running"
      />,
    );
    expect(container.querySelectorAll("span > span").length).toBe(2);
  });
});

// ── WorkItemCard (issues #5, #6, #7, #8, #9) ─────────────────────────────────

describe("<WorkItemCard>", () => {
  it("renders PriorityBars (issue #5) instead of a plain priority text chip", () => {
    render(withProviders(<WorkItemCard item={baseItem({ priority: 1 })} />));
    expect(screen.getByRole("img", { name: "P0 紧急" })).toBeTruthy();
  });

  it("renders an ActorAvatar (issue #6) for an agent-owned card", () => {
    render(withProviders(<WorkItemCard item={baseItem({ owner: "agent" })} />));
    expect(screen.getByRole("img", { name: "agent" })).toBeTruthy();
  });

  it("renders an ActorAvatar for a human owner with derived initials", () => {
    render(
      withProviders(
        <WorkItemCard item={baseItem({ owner: "steve.jobs@example.com" })} />,
      ),
    );
    expect(screen.getByRole("img", { name: "SJ" })).toBeTruthy();
  });

  it("shows a running run-signal line with breathing StatusRing + elapsed time (issue #7)", () => {
    render(
      withProviders(
        <WorkItemCard
          item={baseItem({
            status: "running",
            dispatchedAt: new Date(Date.now() - 65_000).toISOString(),
          })}
        />,
      ),
    );
    expect(screen.getByText(/执行中/)).toBeTruthy();
    expect(screen.getByRole("img", { name: "进行中" })).toBeTruthy();
  });

  it("shows a RunBadge deep link when orchestratorRunId is present (issue #7)", () => {
    render(
      withProviders(
        <WorkItemCard
          item={baseItem({
            status: "running",
            orchestratorRunId: "run_8f3k21",
            dispatchedAt: new Date().toISOString(),
          })}
        />,
      ),
    );
    const link = screen.getByRole("link", { name: /run_8f3k21/ });
    expect(link.getAttribute("href")).toBe("/orchestrator/runs/run_8f3k21");
  });

  it("shows a queued run-signal line", () => {
    render(
      withProviders(<WorkItemCard item={baseItem({ status: "queued" })} />),
    );
    expect(screen.getByText("排队中")).toBeTruthy();
    expect(screen.getByRole("img", { name: "排队" })).toBeTruthy();
  });

  it("shows an awaiting-gate hand-stop signal for a blocked item", () => {
    render(
      withProviders(<WorkItemCard item={baseItem({ status: "blocked" })} />),
    );
    expect(screen.getByText("等待人工确认")).toBeTruthy();
    expect(screen.getByRole("img", { name: "门前等待" })).toBeTruthy();
  });

  it("renders mini-step dots (issue #8), not a redundant '当前: X' text label", () => {
    render(withProviders(<WorkItemCard item={baseItem()} />));
    expect(screen.queryByText(/^当前:/)).toBeNull();
  });

  it("shows a plannedStages-subset caption only when it is a genuine subset", () => {
    const { rerender } = render(
      withProviders(
        <WorkItemCard
          item={baseItem({
            plannedStages: ["实施", "测试"],
            currentStageName: "实施",
          })}
        />,
      ),
    );
    expect(screen.getByText(/阶段子集：实施 → 测试/)).toBeTruthy();

    cleanup();
    render(
      withProviders(<WorkItemCard item={baseItem({ plannedStages: [] })} />),
    );
    expect(screen.queryByText(/阶段子集/)).toBeNull();
  });

  // ── Failed card (issue #9) ──────────────────────────────────────────────

  it("truncates the failed card to a single real error line instead of dumping the full description", () => {
    const activity: ActivityResponse = {
      dispatched: true,
      thread: null,
      events: [],
      runs: [
        {
          id: "run_1",
          status: "failed",
          nodes: [
            {
              nodeIdInDag: "n1",
              status: "failed",
              error: "gitRemote 认证失败 · permanent",
            },
          ],
        },
      ],
      spawns: [],
    };
    mockUseActivity.mockReturnValue({ data: activity, isLoading: false });

    const longDescription =
      "这是一段非常长的原始需求描述文本，".repeat(20) +
      "不应该被当作错误信息整段塞进失败卡片的红色底块中，否则卡片高度会失控。";

    render(
      withProviders(
        <WorkItemCard
          item={baseItem({ status: "failed", description: longDescription })}
        />,
      ),
    );

    expect(screen.getByText("gitRemote 认证失败 · permanent")).toBeTruthy();
    expect(screen.queryByText(longDescription)).toBeNull();
  });

  it("shows 重派/回退/升级 hover actions on a failed card", () => {
    mockUseActivity.mockReturnValue({ data: undefined, isLoading: false });
    render(
      withProviders(
        <WorkItemCard
          item={baseItem({
            status: "failed",
            currentStageName: "测试",
            sprintId: "sprint-1",
          })}
        />,
      ),
    );
    expect(screen.getByText("重派")).toBeTruthy();
    expect(screen.getByText("回退")).toBeTruthy();
    expect(screen.getByText("升级")).toBeTruthy();
  });

  it("omits 升级 when the item has no sprintId to escalate against", () => {
    render(
      withProviders(
        <WorkItemCard item={baseItem({ status: "failed", sprintId: null })} />,
      ),
    );
    expect(screen.queryByText("升级")).toBeNull();
  });
});
