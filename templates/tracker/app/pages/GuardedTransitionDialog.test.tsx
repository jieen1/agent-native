// @vitest-environment happy-dom
import type { TransitionOption, WorkItemRunSummary } from "@shared/types";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GuardedTransitionDialog } from "./WorkItemDetailPage";

const mockMutate = vi.fn();

vi.mock("@/hooks/use-tracker", () => ({
  useTransitionWorkItem: () => ({ mutate: mockMutate, isPending: false }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const CURRENT_RUN_ID = "run_6c8p17xyz789";
const HISTORY_RUN_ID = "run_5x1k07abc123";

const currentRun: WorkItemRunSummary = {
  runId: CURRENT_RUN_ID,
  threadId: "th_1",
  branch: "hotfix@v3",
  dispatchedAt: "2026-07-10T10:00:00.000Z",
  superseded: false,
};

const historyRun: WorkItemRunSummary = {
  runId: HISTORY_RUN_ID,
  threadId: "th_0",
  branch: "hotfix@v3",
  dispatchedAt: "2026-07-10T09:31:00.000Z",
  superseded: true,
};

const transitionOption: TransitionOption = {
  target: "实施",
  need: ["commit"],
  summary: "开始实施",
  kind: "manual-override",
};

function renderDialog(props: {
  runs?: WorkItemRunSummary[];
  allowedTransitions?: TransitionOption[];
}) {
  return render(
    <MemoryRouter initialEntries={["/work-items/wi-1"]}>
      <Routes>
        <Route
          path="/work-items/:id"
          element={
            <GuardedTransitionDialog
              item={{
                itemKey: "PAY-201",
                status: "待办",
                currentStageName: "待办",
                execState: null,
                allowedTransitions: props.allowedTransitions ?? [
                  transitionOption,
                ],
              }}
              runs={props.runs}
              open={true}
              onOpenChange={() => {}}
            />
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("<GuardedTransitionDialog> run-id evidence link", () => {
  it("prefills runId from runs[0] when opened with dispatch history", () => {
    renderDialog({ runs: [currentRun, historyRun] });

    // The run-id input should be prefilled with the most recent run id.
    const input = screen.getByPlaceholderText(
      "orchestrator run id",
    ) as HTMLInputElement;
    expect(input.value).toBe(CURRENT_RUN_ID);
  });

  it("renders a clickable orchestrator run link when runId is prefilled", () => {
    renderDialog({ runs: [currentRun, historyRun] });

    // The "Open run in orchestrator" anchor should be present with the correct href.
    const link = screen.getByText("Open run in orchestrator").closest("a");
    expect(link).toBeTruthy();
    expect(link?.getAttribute("href")).toBe(
      `/orchestrator/runs/${CURRENT_RUN_ID}`,
    );
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer");
  });

  it("renders multiple runs as a clickable history list", () => {
    renderDialog({ runs: [currentRun, historyRun] });

    // Both run ids (truncated to 12 chars) should appear in the history list.
    expect(screen.getByText(CURRENT_RUN_ID.slice(0, 12))).toBeTruthy();
    expect(screen.getByText(HISTORY_RUN_ID.slice(0, 12))).toBeTruthy();

    // The superseded run should be marked.
    expect(screen.getByText("(superseded)")).toBeTruthy();

    // History entries should be clickable links to the orchestrator.
    const historyLink = screen
      .getByText(HISTORY_RUN_ID.slice(0, 12))
      .closest("a");
    expect(historyLink?.getAttribute("href")).toBe(
      `/orchestrator/runs/${HISTORY_RUN_ID}`,
    );
  });

  it("does not render run link or history when there are no runs and runId is empty", () => {
    renderDialog({ runs: [] });

    // No "Open run in orchestrator" link when runId is empty.
    expect(screen.queryByText("Open run in orchestrator")).toBeNull();

    // No history list when there are no runs.
    const input = screen.getByPlaceholderText(
      "orchestrator run id",
    ) as HTMLInputElement;
    expect(input.value).toBe("");
  });
});
