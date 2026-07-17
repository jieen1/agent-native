// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BriefsStepView } from "./BriefsStepView";

const mockMutate = vi.fn();

vi.mock("@/hooks/use-tracker", () => ({
  useExtractBriefs: () => ({ mutate: mockMutate, isPending: false }),
}));

vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  return { ...actual, toast: { error: vi.fn(), success: vi.fn() } };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderView() {
  render(
    <BriefsStepView
      sprintId="sprint-1"
      briefsIndexArtifact={undefined}
      briefArtifacts={[]}
      workItemsByKey={new Map()}
    />,
  );
}

function triggerExtractError(message: string) {
  fireEvent.click(screen.getByText("重新提取"));
  const onError = mockMutate.mock.calls[0][1].onError;
  act(() => {
    onError(new Error(message));
  });
}

describe("<BriefsStepView> — extract-briefs error feedback", () => {
  it("renders the design-signoff-required error inline (not a toast) — the one path that already worked", () => {
    renderView();
    triggerExtractError(
      "Action extract-briefs failed: design-signoff 未批准：tech-design v3 尚未通过签核，无法提取 briefs。传入 force=true 可强制提取。",
    );

    expect(screen.getByText(/design-signoff 未批准/)).toBeTruthy();
    expect(screen.getByText("仍然强制提取")).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("surfaces a visible toast for any other extract-briefs failure instead of failing silently (e.g. missing tech-design)", () => {
    renderView();
    triggerExtractError(
      "Action extract-briefs failed: 未找到 sprint 的 tech-design 产物（docKey=tech-design）：extract-briefs 需要先完成技术设计",
    );

    expect(toast.error).toHaveBeenCalledWith(
      "未找到 sprint 的 tech-design 产物（docKey=tech-design）：extract-briefs 需要先完成技术设计",
    );
    // Not the recoverable design-signoff case — no inline banner/force button.
    expect(screen.queryByText("仍然强制提取")).toBeNull();
  });

  it("falls back to a generic toast message when the error has no readable message", () => {
    renderView();
    fireEvent.click(screen.getByText("重新提取"));
    const onError = mockMutate.mock.calls[0][1].onError;
    act(() => {
      onError({});
    });

    expect(toast.error).toHaveBeenCalledWith("briefs 提取失败，请重试");
  });
});
