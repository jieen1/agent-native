import { describe, expect, it, vi } from "vitest";

import type { QueueItem, TrackerWorkItem } from "../../../shared/types.js";
import { resolveWorkItemId, runQueueGateAction } from "../queue-gate-actions";

function makeWorkItem(id: string): TrackerWorkItem {
  return {
    id,
    projectId: "p1",
    sprintId: null,
    itemKey: `TRK-${id}`,
    type: "需求",
    title: `Item ${id}`,
    description: "",
    status: "paused",
    priority: 0,
    risk: "medium",
    tags: [],
    executionMode: "auto",
    currentStageName: "待办",
    plannedStages: [],
    branch: null,
    orchestratorThreadId: null,
    createdAt: "",
    updatedAt: "",
  };
}

function makeQueueItem(queueRowId: string, workItemId: string): QueueItem {
  return {
    id: queueRowId,
    workItemId,
    priority: 0,
    status: "paused",
    currentStage: "待办",
    enqueuedAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    blockedBy: "[]",
    workItem: makeWorkItem(workItemId),
  };
}

describe("resolveWorkItemId", () => {
  it("resolves the underlying work item id for a known queue row id", () => {
    const items = [makeQueueItem("q1", "wi-1"), makeQueueItem("q2", "wi-2")];
    expect(resolveWorkItemId(items, "q2")).toBe("wi-2");
  });

  it("falls back to the given id when the queue row is not found", () => {
    const items = [makeQueueItem("q1", "wi-1")];
    expect(resolveWorkItemId(items, "missing")).toBe("missing");
  });
});

describe("runQueueGateAction — approve semantics (enqueue-work-item)", () => {
  it("hides the row, calls the real action with the resolved workItemId, and reports success without unhiding", async () => {
    const items = [makeQueueItem("q1", "wi-1")];
    const hide = vi.fn();
    const unhide = vi.fn();
    const onSuccess = vi.fn();
    const mutateAsync = vi
      .fn()
      .mockResolvedValue({ id: "wi-1", status: "queued" });

    await runQueueGateAction({
      id: "q1",
      items,
      mutateAsync,
      hide,
      unhide,
      onSuccess,
    });

    expect(hide).toHaveBeenCalledWith("q1");
    expect(mutateAsync).toHaveBeenCalledWith({ workItemId: "wi-1" });
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(unhide).not.toHaveBeenCalled();
  });

  it("rolls back the optimistic hide when the real action fails", async () => {
    const items = [makeQueueItem("q1", "wi-1")];
    const hide = vi.fn();
    const unhide = vi.fn();
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const error = new Error("blocked by dependency");
    const mutateAsync = vi.fn().mockRejectedValue(error);

    await runQueueGateAction({
      id: "q1",
      items,
      mutateAsync,
      hide,
      unhide,
      onSuccess,
      onError,
    });

    expect(hide).toHaveBeenCalledWith("q1");
    expect(mutateAsync).toHaveBeenCalledWith({ workItemId: "wi-1" });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(unhide).toHaveBeenCalledWith("q1");
    expect(onError).toHaveBeenCalledWith(error);
  });
});

describe("runQueueGateAction — reject semantics (dequeue-work-item)", () => {
  it("hides the row, calls the real dequeue action with the resolved workItemId, and reports success without unhiding", async () => {
    const items = [makeQueueItem("q9", "wi-9")];
    const hide = vi.fn();
    const unhide = vi.fn();
    const onSuccess = vi.fn();
    const mutateAsync = vi
      .fn()
      .mockResolvedValue({ workItemId: "wi-9", removed: true });

    await runQueueGateAction({
      id: "q9",
      items,
      mutateAsync,
      hide,
      unhide,
      onSuccess,
    });

    expect(hide).toHaveBeenCalledWith("q9");
    expect(mutateAsync).toHaveBeenCalledWith({ workItemId: "wi-9" });
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(unhide).not.toHaveBeenCalled();
  });

  it("rolls back the optimistic hide when the dequeue action fails", async () => {
    const items = [makeQueueItem("q9", "wi-9")];
    const hide = vi.fn();
    const unhide = vi.fn();
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const error = new Error("Not authenticated");
    const mutateAsync = vi.fn().mockRejectedValue(error);

    await runQueueGateAction({
      id: "q9",
      items,
      mutateAsync,
      hide,
      unhide,
      onSuccess,
      onError,
    });

    expect(hide).toHaveBeenCalledWith("q9");
    expect(onSuccess).not.toHaveBeenCalled();
    expect(unhide).toHaveBeenCalledWith("q9");
    expect(onError).toHaveBeenCalledWith(error);
  });

  it("still resolves and calls the action even if the queue row id is unknown (fallback to raw id)", async () => {
    const items: QueueItem[] = [];
    const hide = vi.fn();
    const unhide = vi.fn();
    const mutateAsync = vi.fn().mockResolvedValue({ removed: true });

    await runQueueGateAction({
      id: "stale-id",
      items,
      mutateAsync,
      hide,
      unhide,
    });

    expect(mutateAsync).toHaveBeenCalledWith({ workItemId: "stale-id" });
  });
});

describe("runQueueGateAction — call ordering", () => {
  it("hides before the mutation settles (optimistic-first)", async () => {
    const items = [makeQueueItem("q1", "wi-1")];
    const calls: string[] = [];
    const hide = vi.fn(() => calls.push("hide"));
    const unhide = vi.fn(() => calls.push("unhide"));
    const mutateAsync = vi.fn().mockImplementation(async () => {
      calls.push("mutate");
      return {};
    });

    await runQueueGateAction({ id: "q1", items, mutateAsync, hide, unhide });

    expect(calls).toEqual(["hide", "mutate"]);
  });
});
