import type { ActivityResponse, WorkItemRunSummary } from "@shared/types";
// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { RunEvidenceList } from "@/components/RunEvidenceList";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderWithProviders(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

afterEach(() => {
  cleanup();
});

const baseRun: WorkItemRunSummary = {
  runId: "run_abc123def456",
  threadId: "th_1",
  branch: "orchestrator/PRJ-1",
  dispatchedAt: "2026-07-10T10:00:00.000Z",
  superseded: false,
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

  it("shows a skeleton per run while the activity poll is still loading", () => {
    renderWithProviders(
      <RunEvidenceList
        runs={[baseRun]}
        activity={undefined}
        activityLoading={true}
      />,
    );
    expect(screen.getByTestId("run-evidence-skeleton")).toBeTruthy();
    // The deep link row itself still renders immediately (not gated on activity).
    expect(screen.getByText(/run_abc123de/)).toBeTruthy();
  });

  it("renders the node mini-map, status, and transcript link on success", () => {
    const activity = activityWith([
      {
        id: baseRun.runId!,
        status: "done",
        nodes: [
          { nodeIdInDag: "design", type: "cc", status: "done" },
          { nodeIdInDag: "develop", type: "vllm", status: "done" },
          {
            nodeIdInDag: "review",
            type: "cc",
            status: "failed",
            error: "boom",
          },
        ],
      },
    ]);
    renderWithProviders(
      <RunEvidenceList
        runs={[baseRun]}
        activity={activity}
        activityLoading={false}
      />,
    );

    expect(screen.getByText("2/3 节点")).toBeTruthy();
    expect(screen.getByText("失败 1")).toBeTruthy();
    expect(screen.getByText("done")).toBeTruthy();
    expect(screen.getByText("查看完整转录")).toBeTruthy();
    const link = screen.getByText("查看完整转录").closest("a");
    expect(link?.getAttribute("href")).toBe(
      `/orchestrator/runs/${baseRun.runId}`,
    );
  });

  it("degrades to a fallback message (never a fabricated count) when the run can't be read back", () => {
    const activity = activityWith([], { runs: "orchestrator unreachable" });
    renderWithProviders(
      <RunEvidenceList
        runs={[baseRun]}
        activity={activity}
        activityLoading={false}
      />,
    );

    expect(screen.getByText("节点状态读取失败")).toBeTruthy();
    // Still shows the deep link + transcript link even when node data failed.
    expect(screen.getByText("查看完整转录")).toBeTruthy();
    expect(screen.queryByText(/\d+\/\d+ 节点/)).toBeNull();
  });

  it("shows a neutral placeholder (not an error) when the run simply hasn't been tag-correlated yet", () => {
    const activity = activityWith([]);
    renderWithProviders(
      <RunEvidenceList
        runs={[baseRun]}
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
});
