// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RunMergeControl } from "./RunMergeControl";

const mocks = vi.hoisted(() => ({
  ciData: undefined as Record<string, unknown> | undefined,
  mutate: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("@agent-native/core/client", () => ({
  cn: (...values: Array<string | false | null | undefined>) =>
    values.filter(Boolean).join(" "),
  useActionQuery: () => ({ data: mocks.ciData, isLoading: false }),
  useActionMutation: () => ({
    mutate: (...args: unknown[]) => mocks.mutate(...args),
    isPending: false,
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mocks.toastSuccess(...args),
    error: (...args: unknown[]) => mocks.toastError(...args),
    info: (...args: unknown[]) => mocks.toastInfo(...args),
  },
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.ciData = undefined;
  mocks.mutate.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
  mocks.toastInfo.mockReset();
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container.remove();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function render(props: {
  workspaceId: string | null;
  prUrl: string | null;
  runStatus: "done" | "running" | "failed" | "cancelled" | "pending" | "paused";
}) {
  root = createRoot(container);
  await act(async () => {
    root.render(<RunMergeControl {...props} />);
  });
}

function findButton(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(text),
  ) as HTMLButtonElement | undefined;
}

describe("RunMergeControl", () => {
  it("renders nothing when there is no workspace or no PR yet", async () => {
    await render({
      workspaceId: null,
      prUrl: "https://github.com/x/y/pull/1",
      runStatus: "done",
    });
    expect(container.textContent).toBe("");

    await act(async () => root.unmount());
    await render({ workspaceId: "ws1", prUrl: null, runStatus: "done" });
    expect(container.textContent).toBe("");
  });

  it("disables the merge button until the run is done", async () => {
    mocks.ciData = {
      state: "green",
      prUrl: "u",
      prState: "OPEN",
      checks: [],
      summary: "ok",
    };
    await render({
      workspaceId: "ws1",
      prUrl: "https://github.com/x/y/pull/1",
      runStatus: "running",
    });
    const btn = findButton("合并到 main");
    expect(btn).toBeTruthy();
    expect(btn?.disabled).toBe(true);
  });

  it("disables the merge button and shows a merged badge once the PR is already MERGED", async () => {
    mocks.ciData = {
      state: "green",
      prUrl: "u",
      prState: "MERGED",
      checks: [],
      summary: "ok",
    };
    await render({
      workspaceId: "ws1",
      prUrl: "https://github.com/x/y/pull/1",
      runStatus: "done",
    });
    expect(findButton("合并到 main")?.disabled).toBe(true);
    expect(container.textContent).toContain("已合并");
  });

  it("enables the merge button when done, PR open, and CI green", async () => {
    mocks.ciData = {
      state: "green",
      prUrl: "u",
      prState: "OPEN",
      checks: [],
      summary: "ok",
    };
    await render({
      workspaceId: "ws1",
      prUrl: "https://github.com/x/y/pull/1",
      runStatus: "done",
    });
    expect(findButton("合并到 main")?.disabled).toBe(false);
  });

  it("opens a confirmation dialog and calls workspaceMergePr on confirm, rendering a real success result", async () => {
    mocks.ciData = {
      state: "green",
      prUrl: "u",
      prState: "OPEN",
      checks: [],
      summary: "ok",
    };
    mocks.mutate.mockImplementation((_args, opts) => {
      opts?.onSuccess?.({
        workspaceId: "ws1",
        merged: true,
        sha: "abc1234def",
      });
    });
    await render({
      workspaceId: "ws1",
      prUrl: "https://github.com/x/y/pull/1",
      runStatus: "done",
    });

    const trigger = findButton("合并到 main")!;
    await act(async () => {
      trigger.click();
    });
    const confirmBtn = findButton("确认合并");
    expect(confirmBtn).toBeTruthy();
    await act(async () => {
      confirmBtn!.click();
    });

    expect(mocks.mutate).toHaveBeenCalledWith(
      { workspaceId: "ws1" },
      expect.anything(),
    );
    expect(mocks.toastSuccess).toHaveBeenCalled();
    expect(container.textContent).toContain("已合并到 main");
    expect(container.textContent).toContain("abc1234");
  });

  it("surfaces a real, honest failure reason instead of faking success", async () => {
    mocks.ciData = {
      state: "red",
      prUrl: "u",
      prState: "OPEN",
      checks: [],
      summary: "failing",
    };
    mocks.mutate.mockImplementation((_args, opts) => {
      opts?.onSuccess?.({
        workspaceId: "ws1",
        merged: false,
        reason: "ci_not_green: 1 check(s) not passing",
      });
    });
    // CI is red, so the button is disabled by default — force a direct call
    // to the merge mutation by rendering with CI green then flipping ciData
    // is unnecessary here: exercise the failure-path rendering directly by
    // invoking the same confirm flow with CI momentarily green.
    mocks.ciData = {
      state: "green",
      prUrl: "u",
      prState: "OPEN",
      checks: [],
      summary: "ok",
    };
    await render({
      workspaceId: "ws1",
      prUrl: "https://github.com/x/y/pull/1",
      runStatus: "done",
    });
    await act(async () => {
      findButton("合并到 main")!.click();
    });
    await act(async () => {
      findButton("确认合并")!.click();
    });

    expect(mocks.toastError).toHaveBeenCalled();
    expect(container.textContent).toContain("ci_not_green");
  });

  it("treats an idempotent double-merge attempt as informational, not an error", async () => {
    mocks.ciData = {
      state: "green",
      prUrl: "u",
      prState: "OPEN",
      checks: [],
      summary: "ok",
    };
    mocks.mutate.mockImplementation((_args, opts) => {
      opts?.onSuccess?.({
        workspaceId: "ws1",
        merged: false,
        reason: "PR state is 'MERGED', not OPEN",
      });
    });
    await render({
      workspaceId: "ws1",
      prUrl: "https://github.com/x/y/pull/1",
      runStatus: "done",
    });
    await act(async () => {
      findButton("合并到 main")!.click();
    });
    await act(async () => {
      findButton("确认合并")!.click();
    });

    expect(mocks.toastInfo).toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(container.textContent).toContain("已经合并过了");
  });
});
