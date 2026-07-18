// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RunMergeControl } from "./RunMergeControl";

// A passing default for the independent-review gate (task board #95) — most
// of these tests exercise the pre-existing CI/PR-state disabling logic and
// don't care about the review gate, so it defaults to already-passed rather
// than forcing every existing test to also stub a review. The dedicated
// "independent review gate" describe block below overrides this per test.
const PASSED_REVIEW_GATE = {
  workspaceId: "ws1",
  review: {
    reviewRunId: "v3r_review1",
    status: "done" as const,
    verdict: "safe_to_merge" as const,
    summary: "No blocking issues found.",
    findings: [] as unknown[],
    startedAt: "2026-07-18T00:00:00.000Z",
    completedAt: "2026-07-18T00:05:00.000Z",
    error: null,
  },
  override: null,
  canMerge: true,
  source: "review-passed" as const,
  reason: "独立复核通过：未发现需要阻塞合并的问题",
};

const mocks = vi.hoisted(() => ({
  ciData: undefined as Record<string, unknown> | undefined,
  reviewGateData: undefined as Record<string, unknown> | undefined,
  mergeMutate: vi.fn(),
  reviewStartMutate: vi.fn(),
  reviewOverrideMutate: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("@agent-native/core/client", () => ({
  cn: (...values: Array<string | false | null | undefined>) =>
    values.filter(Boolean).join(" "),
  useActionQuery: (name: string) => {
    if (name === "workspaceCiWatch")
      return { data: mocks.ciData, isLoading: false };
    if (name === "mergeReviewGet")
      return { data: mocks.reviewGateData, isLoading: false };
    return { data: undefined, isLoading: false };
  },
  useActionMutation: (name: string) => {
    if (name === "workspaceMergePr")
      return {
        mutate: (...args: unknown[]) => mocks.mergeMutate(...args),
        isPending: false,
      };
    if (name === "mergeReviewStart")
      return {
        mutate: (...args: unknown[]) => mocks.reviewStartMutate(...args),
        isPending: false,
      };
    if (name === "mergeReviewOverride")
      return {
        mutate: (...args: unknown[]) => mocks.reviewOverrideMutate(...args),
        isPending: false,
      };
    return { mutate: vi.fn(), isPending: false };
  },
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
  mocks.reviewGateData = PASSED_REVIEW_GATE;
  mocks.mergeMutate.mockReset();
  mocks.reviewStartMutate.mockReset();
  mocks.reviewOverrideMutate.mockReset();
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
  runId?: string;
}) {
  root = createRoot(container);
  await act(async () => {
    root.render(<RunMergeControl {...props} runId={props.runId ?? "run-1"} />);
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
    mocks.mergeMutate.mockImplementation((_args, opts) => {
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

    expect(mocks.mergeMutate).toHaveBeenCalledWith(
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
    mocks.mergeMutate.mockImplementation((_args, opts) => {
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
    mocks.mergeMutate.mockImplementation((_args, opts) => {
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

function setTextareaValue(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("RunMergeControl — independent review gate (task board #95)", () => {
  const CI_GREEN_OPEN = {
    state: "green",
    prUrl: "u",
    prState: "OPEN",
    checks: [],
    summary: "ok",
  };

  it("blocks merge when no independent review has ever run, even with CI green and an open PR", async () => {
    mocks.ciData = CI_GREEN_OPEN;
    mocks.reviewGateData = {
      workspaceId: "ws1",
      review: null,
      override: null,
      canMerge: false,
      source: "blocked",
      reason: "尚未运行独立复核，无法合并",
    };
    await render({
      workspaceId: "ws1",
      prUrl: "https://github.com/x/y/pull/1",
      runStatus: "done",
    });

    const mergeBtn = findButton("合并到 main");
    expect(mergeBtn?.disabled).toBe(true);
    expect(mergeBtn?.title).toContain("尚未运行独立复核");
    expect(container.textContent).toContain("未独立复核");
    expect(findButton("运行独立复核")).toBeTruthy();
  });

  it("starting a review calls mergeReviewStart with the workspace and origin run id", async () => {
    mocks.ciData = CI_GREEN_OPEN;
    mocks.reviewGateData = {
      workspaceId: "ws1",
      review: null,
      override: null,
      canMerge: false,
      source: "blocked",
      reason: "尚未运行独立复核，无法合并",
    };
    await render({
      workspaceId: "ws1",
      prUrl: "https://github.com/x/y/pull/1",
      runStatus: "done",
      runId: "run-42",
    });

    await act(async () => {
      findButton("运行独立复核")!.click();
    });

    expect(mocks.reviewStartMutate).toHaveBeenCalledWith(
      { workspaceId: "ws1", runId: "run-42" },
      expect.anything(),
    );
  });

  it("blocks merge and surfaces the findings when the review flags concerns with no override", async () => {
    mocks.ciData = CI_GREEN_OPEN;
    mocks.reviewGateData = {
      workspaceId: "ws1",
      review: {
        reviewRunId: "v3r_review1",
        status: "done",
        verdict: "concerns_found",
        summary: "Missing tests for the new branch.",
        findings: ["no unit test for the new gate", "hardcoded timeout"],
        startedAt: "2026-07-18T00:00:00.000Z",
        completedAt: "2026-07-18T00:05:00.000Z",
        error: null,
      },
      override: null,
      canMerge: false,
      source: "blocked",
      reason: "独立复核发现问题，需人工确认后才能合并",
    };
    await render({
      workspaceId: "ws1",
      prUrl: "https://github.com/x/y/pull/1",
      runStatus: "done",
    });

    expect(findButton("合并到 main")?.disabled).toBe(true);
    expect(container.textContent).toContain("发现问题");

    await act(async () => {
      findButton("发现问题")!.click();
    });
    // The Dialog's content portals to document.body, outside `container`.
    expect(document.body.textContent).toContain(
      "Missing tests for the new branch",
    );
    expect(document.body.textContent).toContain(
      "no unit test for the new gate",
    );
    expect(document.body.textContent).toContain("hardcoded timeout");
  });

  it("lets a human override a flagged review with a reason, calling mergeReviewOverride", async () => {
    mocks.ciData = CI_GREEN_OPEN;
    mocks.reviewGateData = {
      workspaceId: "ws1",
      review: {
        reviewRunId: "v3r_review1",
        status: "done",
        verdict: "concerns_found",
        summary: "Missing tests for the new branch.",
        findings: ["no unit test for the new gate"],
        startedAt: "2026-07-18T00:00:00.000Z",
        completedAt: "2026-07-18T00:05:00.000Z",
        error: null,
      },
      override: null,
      canMerge: false,
      source: "blocked",
      reason: "独立复核发现问题，需人工确认后才能合并",
    };
    await render({
      workspaceId: "ws1",
      prUrl: "https://github.com/x/y/pull/1",
      runStatus: "done",
    });

    await act(async () => {
      findButton("发现问题")!.click();
    });

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    await act(async () => {
      setTextareaValue(
        textarea,
        "verified manually, findings are false positives",
      );
    });

    const overrideBtn = findButton("人工确认：仍然合并");
    expect(overrideBtn?.disabled).toBe(false);
    await act(async () => {
      overrideBtn!.click();
    });

    expect(mocks.reviewOverrideMutate).toHaveBeenCalledWith(
      {
        workspaceId: "ws1",
        reason: "verified manually, findings are false positives",
      },
      expect.anything(),
    );
  });

  it("enables merge once a human override is recorded against the current review", async () => {
    mocks.ciData = CI_GREEN_OPEN;
    mocks.reviewGateData = {
      workspaceId: "ws1",
      review: {
        reviewRunId: "v3r_review1",
        status: "done",
        verdict: "concerns_found",
        summary: "flagged",
        findings: ["x"],
        startedAt: null,
        completedAt: null,
        error: null,
      },
      override: {
        reviewRunId: "v3r_review1",
        reason: "reviewed manually, fine to merge",
        overriddenBy: "human@example.com",
        createdAt: "2026-07-18T01:00:00.000Z",
      },
      canMerge: true,
      source: "human-override",
      reason: "已人工确认合并：reviewed manually, fine to merge",
    };
    await render({
      workspaceId: "ws1",
      prUrl: "https://github.com/x/y/pull/1",
      runStatus: "done",
    });

    expect(findButton("合并到 main")?.disabled).toBe(false);
    expect(container.textContent).toContain("已人工确认合并");
  });

  it("fails closed: blocks merge while the review gate result is still loading", async () => {
    mocks.ciData = CI_GREEN_OPEN;
    mocks.reviewGateData = undefined;
    await render({
      workspaceId: "ws1",
      prUrl: "https://github.com/x/y/pull/1",
      runStatus: "done",
    });

    expect(findButton("合并到 main")?.disabled).toBe(true);
  });
});
