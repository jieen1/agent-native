// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeployTab } from "./DeployTab";

const mocks = vi.hoisted(() => ({
  history: [] as Record<string, unknown>[],
  deployStatus: undefined as Record<string, unknown> | undefined,
  triggerMutate: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@agent-native/core/client", () => ({
  cn: (...values: Array<string | false | null | undefined>) =>
    values.filter(Boolean).join(" "),
  useActionQuery: (name: string) => {
    if (name === "list-deploy-runs")
      return { data: mocks.history, isLoading: false };
    if (name === "deploy-status")
      return { data: mocks.deployStatus, isLoading: false };
    return { data: undefined, isLoading: false };
  },
  useActionMutation: () => ({
    mutate: (...args: unknown[]) => mocks.triggerMutate(...args),
    isPending: false,
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mocks.toastSuccess(...args),
    error: (...args: unknown[]) => mocks.toastError(...args),
    info: vi.fn(),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts?.apps ? `${key}:${opts.apps}` : key,
  }),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.history = [];
  mocks.deployStatus = undefined;
  mocks.triggerMutate.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container.remove();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function render() {
  root = createRoot(container);
  await act(async () => {
    root.render(<DeployTab />);
  });
}

function findButton(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(text),
  ) as HTMLButtonElement | undefined;
}

describe("DeployTab", () => {
  it("renders both app checkboxes checked by default and an empty history state", async () => {
    await render();
    expect(container.querySelectorAll('button[role="checkbox"]').length).toBe(
      2,
    );
    expect(container.textContent).toContain("settings.deployHistoryEmpty");
  });

  it("confirms via AlertDialog before triggering a real deploy, and shows a live-started toast", async () => {
    mocks.triggerMutate.mockImplementation((_args, opts) => {
      opts?.onSuccess?.({ deployRunId: "deploy_1", status: "queued" });
    });
    await render();

    const deployBtn = findButton("settings.deployTrigger")!;
    expect(deployBtn.disabled).toBe(false);
    await act(async () => {
      deployBtn.click();
    });

    const confirmBtn = findButton("settings.deployConfirmAction");
    expect(confirmBtn).toBeTruthy();
    await act(async () => {
      confirmBtn!.click();
    });

    expect(mocks.triggerMutate).toHaveBeenCalledWith(
      { apps: ["orchestrator", "tracker"], target: "101" },
      expect.anything(),
    );
    expect(mocks.toastSuccess).toHaveBeenCalled();
  });

  it("disables the deploy button while a deploy is already queued/running", async () => {
    mocks.history = [
      {
        id: "deploy_1",
        target: "101",
        apps: ["orchestrator"],
        status: "running",
        stage: "building",
        commitSha: null,
        error: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
        createdAt: new Date().toISOString(),
        triggeredBy: "a@b.com",
      },
    ];
    await render();
    expect(findButton("settings.deployTrigger")?.disabled).toBe(true);
  });

  it("surfaces a real, honest trigger failure (e.g. deploy not configured) instead of faking success", async () => {
    mocks.triggerMutate.mockImplementation((_args, opts) => {
      opts?.onError?.(
        new Error(
          "Deploy is not configured — set DEPLOY_SSH_HOST in Settings → Deploy.",
        ),
      );
    });
    await render();
    await act(async () => {
      findButton("settings.deployTrigger")!.click();
    });
    await act(async () => {
      findButton("settings.deployConfirmAction")!.click();
    });

    expect(mocks.toastError).toHaveBeenCalled();
    expect(container.textContent).toContain("Deploy is not configured");
  });

  it("renders live stage-log progress for the active deploy, not just a spinner", async () => {
    mocks.history = [
      {
        id: "deploy_1",
        target: "101",
        apps: ["orchestrator"],
        status: "running",
        stage: "building",
        commitSha: null,
        error: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
        createdAt: new Date().toISOString(),
        triggeredBy: "a@b.com",
      },
    ];
    mocks.deployStatus = {
      id: "deploy_1",
      target: "101",
      apps: ["orchestrator"],
      status: "running",
      stage: "building",
      stageLog: [
        {
          stage: "backing-up",
          startedAt: "t0",
          completedAt: "t1",
          ok: true,
          detail: "backed up orchestrator",
        },
        { stage: "building", startedAt: "t1" },
      ],
      commitSha: null,
      backupRef: null,
      healthCheckResult: null,
      error: null,
      startedAt: "t0",
      completedAt: null,
      createdAt: "t0",
      updatedAt: "t1",
      triggeredBy: "a@b.com",
    };
    await render();
    expect(container.textContent).toContain("Backing up");
    expect(container.textContent).toContain("Building");
    expect(container.textContent).toContain("backed up orchestrator");
  });
});
