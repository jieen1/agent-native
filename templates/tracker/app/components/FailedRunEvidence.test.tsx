import type { ActivityResponse } from "@shared/types";
// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FailedRunEvidence } from "@/components/FailedRunEvidence";

afterEach(() => {
  cleanup();
});

function activityWith(runs: ActivityResponse["runs"]): ActivityResponse {
  return {
    dispatched: true,
    thread: null,
    events: [],
    runs,
    spawns: [],
  };
}

describe("<FailedRunEvidence> — Inbox 失败路由「最后错误 · 证据」块", () => {
  it("shows a skeleton while the activity poll is still loading and no data has arrived yet", () => {
    render(<FailedRunEvidence activity={undefined} activityLoading={true} />);
    expect(screen.getByTestId("failed-run-evidence-skeleton")).toBeTruthy();
  });

  it("renders the raw error text and the section label when a failed node carries error text", () => {
    const activity = activityWith([
      {
        id: "run_6c8p17xyz789",
        status: "failed",
        nodes: [
          { nodeIdInDag: "reproduce", type: "cc", status: "done" },
          { nodeIdInDag: "fix", type: "vllm", status: "done" },
          {
            nodeIdInDag: "pr",
            type: "cc",
            status: "failed",
            error: "git push origin sprint-3 -> 403: authentication failed",
          },
        ],
      },
    ]);
    render(<FailedRunEvidence activity={activity} activityLoading={false} />);

    expect(screen.getByText("最后错误 · 证据")).toBeTruthy();
    expect(
      screen.getByText(
        "git push origin sprint-3 -> 403: authentication failed",
      ),
    ).toBeTruthy();
    expect(screen.getByText("节点 pr 失败")).toBeTruthy();
  });

  it("finds a failing node from ANY run get-activity returned, not just a 'current' one — the Inbox card has no history section", () => {
    const activity = activityWith([
      {
        id: "run_current",
        status: "done",
        nodes: [{ nodeIdInDag: "pr", type: "cc", status: "done" }],
      },
      {
        id: "run_superseded_but_still_the_last_failure",
        status: "failed",
        nodes: [
          {
            nodeIdInDag: "pr",
            type: "cc",
            status: "failed",
            error: "connection reset by peer",
          },
        ],
      },
    ]);
    render(<FailedRunEvidence activity={activity} activityLoading={false} />);
    expect(screen.getByText("connection reset by peer")).toBeTruthy();
  });

  it("renders nothing (no fabricated card) when there is no activity yet and loading has finished", () => {
    const { container } = render(
      <FailedRunEvidence activity={undefined} activityLoading={false} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when every node succeeded — never invents an error", () => {
    const activity = activityWith([
      {
        id: "run_ok",
        status: "done",
        nodes: [
          { nodeIdInDag: "design", type: "cc", status: "done" },
          { nodeIdInDag: "develop", type: "vllm", status: "done" },
        ],
      },
    ]);
    const { container } = render(
      <FailedRunEvidence activity={activity} activityLoading={false} />,
    );
    expect(container.innerHTML).toBe("");
    expect(screen.queryByText("最后错误 · 证据")).toBeNull();
  });

  it("renders nothing when a failed node has no error text (nothing honest to show)", () => {
    const activity = activityWith([
      {
        id: "run_no_error_text",
        status: "failed",
        nodes: [{ nodeIdInDag: "pr", type: "cc", status: "failed" }],
      },
    ]);
    const { container } = render(
      <FailedRunEvidence activity={activity} activityLoading={false} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when get-activity returned no runs at all", () => {
    const activity = activityWith([]);
    const { container } = render(
      <FailedRunEvidence activity={activity} activityLoading={false} />,
    );
    expect(container.innerHTML).toBe("");
  });
});
