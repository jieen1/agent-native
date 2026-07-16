import type { ActivityResponse, WorkItemRunSummary } from "@shared/types";
// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { RunBadgeCompact, RunEvidenceList } from "@/components/RunEvidenceList";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderWithProviders(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

afterEach(() => {
  cleanup();
});

const currentRun: WorkItemRunSummary = {
  runId: "run_6c8p17xyz789",
  threadId: "th_1",
  branch: "hotfix@v3",
  dispatchedAt: "2026-07-10T10:00:00.000Z",
  superseded: false,
};

const historyRun: WorkItemRunSummary = {
  runId: "run_5x1k07abc123",
  threadId: "th_0",
  branch: "hotfix@v3",
  dispatchedAt: "2026-07-10T09:31:00.000Z",
  superseded: true,
};

function activityWith(
  runs: ActivityResponse["runs"],
  errors?: ActivityResponse["errors"],
): ActivityResponse {
  return {
    dispatched: true,
    thread: null,
    events: [],
    runs,
    spawns: [],
    errors,
  };
}

describe("<RunEvidenceList>", () => {
  it("renders nothing when the work item has no associated runs", () => {
    const { container } = renderWithProviders(
      <RunEvidenceList
        runs={[]}
        activity={undefined}
        activityLoading={false}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("shows a skeleton while the activity poll is still loading", () => {
    renderWithProviders(
      <RunEvidenceList
        runs={[currentRun]}
        activity={undefined}
        activityLoading={true}
      />,
    );
    expect(screen.getByTestId("run-evidence-skeleton")).toBeTruthy();
    // The deep link header itself still renders immediately (not gated on activity).
    expect(screen.getByText(/run_6c8p17xy/)).toBeTruthy();
  });

  it("renders the real node chain (not an aggregate count) and the failing node's raw error text", () => {
    const activity = activityWith([
      {
        id: currentRun.runId!,
        status: "failed",
        nodes: [
          { nodeIdInDag: "reproduce", type: "cc", status: "done" },
          { nodeIdInDag: "fix", type: "vllm", status: "done" },
          { nodeIdInDag: "regression", type: "cc", status: "done" },
          { nodeIdInDag: "reviewer", type: "cc", status: "done" },
          {
            nodeIdInDag: "pr",
            type: "cc",
            status: "failed",
            error: "git push origin sprint-3 -> 403: authentication failed",
          },
        ],
      },
    ]);
    renderWithProviders(
      <RunEvidenceList
        runs={[currentRun]}
        activity={activity}
        activityLoading={false}
      />,
    );

    // Every node in the DAG renders individually, in order — not a "4/5" count.
    for (const id of ["reproduce", "fix", "regression", "reviewer", "pr"]) {
      expect(screen.getByText(id)).toBeTruthy();
    }
    expect(screen.queryByText(/\d+\/\d+ 节点/)).toBeNull();

    // Overall run status badge (translated label, not the raw enum string).
    expect(screen.getByText("失败")).toBeTruthy();

    // The failing node's raw error, shown in full (not truncated to one line).
    expect(
      screen.getByText(
        "git push origin sprint-3 -> 403: authentication failed",
      ),
    ).toBeTruthy();
    expect(screen.getByText("节点 pr 失败")).toBeTruthy();

    expect(screen.getByText("查看完整转录")).toBeTruthy();
    const link = screen.getByText("查看完整转录").closest("a");
    expect(link?.getAttribute("href")).toBe(
      `/orchestrator/runs/${currentRun.runId}`,
    );

    // Single run — no history section.
    expect(screen.queryByText(/历史运行/)).toBeNull();
  });

  it("omits the failure block entirely when every node succeeded", () => {
    const activity = activityWith([
      {
        id: currentRun.runId!,
        status: "done",
        nodes: [
          { nodeIdInDag: "design", type: "cc", status: "done" },
          { nodeIdInDag: "develop", type: "vllm", status: "done" },
        ],
      },
    ]);
    renderWithProviders(
      <RunEvidenceList
        runs={[currentRun]}
        activity={activity}
        activityLoading={false}
      />,
    );
    expect(screen.getByText("成功")).toBeTruthy();
    expect(screen.queryByText(/节点.*失败/)).toBeNull();
  });

  it("degrades to a fallback message (never a fabricated node chain) when the run can't be read back", () => {
    const activity = activityWith([], { runs: "orchestrator unreachable" });
    renderWithProviders(
      <RunEvidenceList
        runs={[currentRun]}
        activity={activity}
        activityLoading={false}
      />,
    );

    expect(screen.getByText("节点状态读取失败")).toBeTruthy();
    expect(screen.getByText("查看完整转录")).toBeTruthy();
  });

  it("shows a neutral placeholder (not an error) when the run simply hasn't been tag-correlated yet", () => {
    const activity = activityWith([]);
    renderWithProviders(
      <RunEvidenceList
        runs={[currentRun]}
        activity={activity}
        activityLoading={false}
      />,
    );

    expect(screen.getByText("暂无节点数据")).toBeTruthy();
    expect(screen.getByText("查看完整转录")).toBeTruthy();
  });

  it("still renders the pending row (no evidence lookup) when a run has no runId yet", () => {
    const pending: WorkItemRunSummary = {
      runId: null,
      threadId: "th_2",
      branch: null,
      dispatchedAt: "2026-07-11T10:00:00.000Z",
      superseded: false,
    };
    renderWithProviders(
      <RunEvidenceList
        runs={[pending]}
        activity={undefined}
        activityLoading={false}
      />,
    );
    expect(screen.getByText("等待运行 id 回填")).toBeTruthy();
    expect(screen.queryByText("查看完整转录")).toBeNull();
  });

  it("collapses prior attempts under a 历史运行 (N) toggle and expands them on click", () => {
    const activity = activityWith([
      {
        id: currentRun.runId!,
        status: "done",
        nodes: [{ nodeIdInDag: "pr", type: "cc", status: "done" }],
      },
      {
        id: historyRun.runId!,
        status: "failed",
        nodes: [{ nodeIdInDag: "pr", type: "cc", status: "failed" }],
      },
    ]);
    renderWithProviders(
      <RunEvidenceList
        runs={[currentRun, historyRun]}
        activity={activity}
        activityLoading={false}
      />,
    );

    const toggle = screen.getByText("历史运行 (1)");
    expect(toggle).toBeTruthy();
    // Collapsed by default — the historical run id isn't in the DOM yet.
    expect(screen.queryByText(/run_5x1k07ab/)).toBeNull();

    // Only the current run's single node ("pr", title="done") exists before
    // expanding history — establishes the baseline for the assertion below.
    expect(screen.queryAllByTitle("done").length).toBe(1);

    fireEvent.click(toggle);

    expect(screen.getByText(/run_5x1k07ab/)).toBeTruthy();
    // History rows are compact — expanding adds no additional node chips
    // (the historical run's failing "pr" node isn't rendered as a chain).
    expect(screen.queryAllByTitle("done").length).toBe(1);
    expect(screen.queryAllByTitle("failed").length).toBe(0);
  });

  it("picks the non-superseded run as current regardless of array order", () => {
    const activity = activityWith([
      {
        id: currentRun.runId!,
        status: "done",
        nodes: [{ nodeIdInDag: "pr", type: "cc", status: "done" }],
      },
    ]);
    // historyRun (superseded) listed first — current must still win the
    // top slot based on `superseded`, not array position.
    renderWithProviders(
      <RunEvidenceList
        runs={[historyRun, currentRun]}
        activity={activity}
        activityLoading={false}
      />,
    );
    expect(screen.getByText("历史运行 (1)")).toBeTruthy();
    expect(screen.getByText("成功")).toBeTruthy();
  });
});

describe("<RunBadgeCompact> — Inspector「执行」组的紧凑关联运行徽标 (原型 s4-work-item.html ~558)", () => {
  it("links to the run detail page with the truncated run id", () => {
    render(
      <RunBadgeCompact
        run={currentRun}
        activity={activityWith([{ id: currentRun.runId!, status: "failed", nodes: [] }])}
      />,
    );
    const link = screen.getByText(/run_6c8p17/).closest("a");
    expect(link?.getAttribute("href")).toBe(
      `/orchestrator/runs/${currentRun.runId}`,
    );
  });

  it("shows the pending placeholder (no link) when the run has no runId yet", () => {
    const pending: WorkItemRunSummary = {
      runId: null,
      threadId: "th_2",
      branch: null,
      dispatchedAt: "2026-07-11T10:00:00.000Z",
      superseded: false,
    };
    render(<RunBadgeCompact run={pending} activity={undefined} />);
    expect(screen.getByText("等待运行 id 回填")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("degrades gracefully (still links, no status dot) when activity hasn't correlated the run yet", () => {
    render(<RunBadgeCompact run={currentRun} activity={undefined} />);
    expect(screen.getByRole("link")).toBeTruthy();
  });
});
