import type { QueueItem, TrackerWorkItem } from "@shared/types";
import { describe, expect, it } from "vitest";

import {
  computeQueueStatsCards,
  groupQueueItems,
  moveIdBetween,
  moveIdToTop,
  parseQueueHealthLog,
  parseQueueWaitingOn,
  queueGroupOf,
  sortDispatchable,
  waitingLabel,
} from "../queue";

function makeWorkItem(
  overrides: Partial<TrackerWorkItem> = {},
): TrackerWorkItem {
  return {
    id: "wi-1",
    projectId: "p1",
    sprintId: null,
    itemKey: "TRK-1",
    type: "需求",
    title: "Item",
    description: "",
    status: "open",
    priority: 2,
    risk: "medium",
    tags: [],
    executionMode: "auto",
    currentStageName: "待办",
    plannedStages: [],
    branch: null,
    orchestratorThreadId: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function makeQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: overrides.id ?? "q1",
    workItemId: overrides.workItemId ?? "wi-1",
    priority: 0,
    status: "queued",
    currentStage: "待办",
    enqueuedAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    blockedBy: "[]",
    position: null,
    waitingOn: "{}",
    healthCheckLog: null,
    workItem: makeWorkItem({ id: overrides.workItemId ?? "wi-1" }),
    ...overrides,
  };
}

// ── parseQueueWaitingOn / parseQueueHealthLog ───────────────────────────────

describe("parseQueueWaitingOn", () => {
  it("returns {} for null/undefined/empty", () => {
    expect(parseQueueWaitingOn(null)).toEqual({});
    expect(parseQueueWaitingOn(undefined)).toEqual({});
    expect(parseQueueWaitingOn("")).toEqual({});
  });

  it("returns {} for malformed JSON instead of throwing", () => {
    expect(parseQueueWaitingOn("{not json")).toEqual({});
  });

  it("parses a dependency descriptor", () => {
    const raw = JSON.stringify({
      type: "dependency",
      items: [{ id: "wi-2", itemKey: "TRK-2" }],
    });
    expect(parseQueueWaitingOn(raw)).toEqual({
      type: "dependency",
      items: [{ id: "wi-2", itemKey: "TRK-2" }],
    });
  });

  it("parses a health descriptor", () => {
    const raw = JSON.stringify({ type: "health", reason: "调度器已暂停" });
    expect(parseQueueWaitingOn(raw)).toEqual({
      type: "health",
      reason: "调度器已暂停",
    });
  });

  it("rejects a bare array (not an object descriptor)", () => {
    expect(parseQueueWaitingOn("[1,2,3]")).toEqual({});
  });
});

describe("parseQueueHealthLog", () => {
  it("returns null for null/malformed input", () => {
    expect(parseQueueHealthLog(null)).toBeNull();
    expect(parseQueueHealthLog("not json")).toBeNull();
    expect(
      parseQueueHealthLog(JSON.stringify({ at: "2026-01-01" })),
    ).toBeNull();
  });

  it("parses a real rejection log entry", () => {
    const raw = JSON.stringify({
      reason: "调度器已暂停",
      at: "2026-01-01T00:00:00.000Z",
    });
    expect(parseQueueHealthLog(raw)).toEqual({
      reason: "调度器已暂停",
      at: "2026-01-01T00:00:00.000Z",
    });
  });
});

// ── queueGroupOf / groupQueueItems ──────────────────────────────────────────

describe("queueGroupOf", () => {
  it("classifies a dispatched/running work item as running regardless of exec_queue status", () => {
    const item = makeQueueItem({
      status: "queued",
      workItem: makeWorkItem({ execState: "dispatched" }),
    });
    expect(queueGroupOf(item)).toBe("running");
  });

  it("classifies status='running' work item as running", () => {
    const item = makeQueueItem({
      workItem: makeWorkItem({ status: "running" }),
    });
    expect(queueGroupOf(item)).toBe("running");
  });

  it("classifies waitingOn.type='health' as health", () => {
    const item = makeQueueItem({
      waitingOn: JSON.stringify({ type: "health", reason: "vLLM 不可达" }),
    });
    expect(queueGroupOf(item)).toBe("health");
  });

  it("running takes precedence over a stale health waitingOn", () => {
    const item = makeQueueItem({
      waitingOn: JSON.stringify({ type: "health", reason: "调度器已暂停" }),
      workItem: makeWorkItem({ execState: "dispatched" }),
    });
    expect(queueGroupOf(item)).toBe("running");
  });

  it("classifies status='blocked' as dependency", () => {
    const item = makeQueueItem({ status: "blocked" });
    expect(queueGroupOf(item)).toBe("dependency");
  });

  it("classifies a plain queued/ready row as dispatchable", () => {
    const item = makeQueueItem({ status: "queued" });
    expect(queueGroupOf(item)).toBe("dispatchable");
  });
});

describe("groupQueueItems", () => {
  it("buckets a mixed list into all four groups and sorts dispatchable by position", () => {
    const running = makeQueueItem({
      id: "q-run",
      workItem: makeWorkItem({ execState: "dispatched" }),
    });
    const dep = makeQueueItem({ id: "q-dep", status: "blocked" });
    const health = makeQueueItem({
      id: "q-health",
      waitingOn: JSON.stringify({ type: "health", reason: "CC 未登录" }),
    });
    const dispatchB = makeQueueItem({ id: "q-b", position: 2, priority: 0 });
    const dispatchA = makeQueueItem({ id: "q-a", position: 1, priority: 0 });

    const groups = groupQueueItems([
      running,
      dep,
      health,
      dispatchB,
      dispatchA,
    ]);
    expect(groups.running.map((i) => i.id)).toEqual(["q-run"]);
    expect(groups.dependency.map((i) => i.id)).toEqual(["q-dep"]);
    expect(groups.health.map((i) => i.id)).toEqual(["q-health"]);
    expect(groups.dispatchable.map((i) => i.id)).toEqual(["q-a", "q-b"]);
  });
});

describe("sortDispatchable", () => {
  it("positioned rows sort before unpositioned rows regardless of priority", () => {
    const positioned = makeQueueItem({ id: "q-pos", position: 1, priority: 0 });
    const highPriorityUnpositioned = makeQueueItem({
      id: "q-hp",
      position: null,
      priority: 4,
    });
    const sorted = sortDispatchable([highPriorityUnpositioned, positioned]);
    expect(sorted.map((i) => i.id)).toEqual(["q-pos", "q-hp"]);
  });

  it("treats position 0 the same as null — the legacy NOT NULL DEFAULT 0 shape some production rows carry (schema.ts docblock)", () => {
    const zeroPosition = makeQueueItem({
      id: "q-zero",
      position: 0,
      priority: 1,
    });
    const nullPosition = makeQueueItem({
      id: "q-null",
      position: null,
      priority: 3,
    });
    const sorted = sortDispatchable([zeroPosition, nullPosition]);
    // Both unpositioned — falls back to priority desc, not to position ordering.
    expect(sorted.map((i) => i.id)).toEqual(["q-null", "q-zero"]);
  });

  it("unpositioned rows fall back to priority desc, then enqueuedAt asc", () => {
    const low = makeQueueItem({
      id: "q-low",
      priority: 1,
      enqueuedAt: "2026-01-01T00:00:00.000Z",
    });
    const high = makeQueueItem({
      id: "q-high",
      priority: 3,
      enqueuedAt: "2026-01-02T00:00:00.000Z",
    });
    const sorted = sortDispatchable([low, high]);
    expect(sorted.map((i) => i.id)).toEqual(["q-high", "q-low"]);
  });
});

// ── waitingLabel ─────────────────────────────────────────────────────────────

describe("waitingLabel", () => {
  it("renders dependency itemKeys", () => {
    const item = makeQueueItem({
      waitingOn: JSON.stringify({
        type: "dependency",
        items: [{ id: "wi-2", itemKey: "TRK-2" }],
      }),
    });
    expect(waitingLabel(item)).toBe("等待 TRK-2");
  });

  it("renders a health reason", () => {
    const item = makeQueueItem({
      waitingOn: JSON.stringify({ type: "health", reason: "vLLM 不可达" }),
    });
    expect(waitingLabel(item)).toBe("不健康：vLLM 不可达");
  });

  it("falls back to legacy blockedBy when waitingOn is empty (pre-v28 rows)", () => {
    const item = makeQueueItem({
      waitingOn: "{}",
      blockedBy: JSON.stringify([{ id: "wi-3", itemKey: "TRK-3" }]),
    });
    expect(waitingLabel(item)).toBe("等待 TRK-3");
  });

  it("returns null when not waiting on anything", () => {
    expect(waitingLabel(makeQueueItem())).toBeNull();
  });
});

// ── computeQueueStatsCards ───────────────────────────────────────────────────

describe("computeQueueStatsCards", () => {
  it("counts each group and derives doneToday/failed from the full work-item list", () => {
    const groups = groupQueueItems([
      makeQueueItem({ id: "q1", status: "queued" }),
      makeQueueItem({ id: "q2", status: "blocked" }),
      makeQueueItem({
        id: "q3",
        waitingOn: JSON.stringify({ type: "health", reason: "x" }),
      }),
      makeQueueItem({
        id: "q4",
        workItem: makeWorkItem({ execState: "dispatched" }),
      }),
    ]);
    const now = new Date("2026-07-17T12:00:00.000Z");
    const allWorkItems = [
      { status: "done", updatedAt: "2026-07-17T09:00:00.000Z" },
      { status: "done", updatedAt: "2026-07-16T09:00:00.000Z" }, // yesterday — excluded
      { status: "failed", updatedAt: "2026-07-17T09:00:00.000Z" },
      { status: "open", updatedAt: "2026-07-17T09:00:00.000Z" },
    ];
    const stats = computeQueueStatsCards(groups, allWorkItems, now);
    expect(stats).toEqual({
      queued: 1,
      running: 1,
      dependency: 1,
      health: 1,
      doneToday: 1,
      failed: 1,
    });
  });
});

// ── reorder helpers ──────────────────────────────────────────────────────────

describe("moveIdToTop", () => {
  it("moves the target id to index 0 and preserves the rest's order", () => {
    expect(moveIdToTop(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
  });

  it("is a no-op shape when the id is already first", () => {
    expect(moveIdToTop(["a", "b"], "a")).toEqual(["a", "b"]);
  });
});

describe("moveIdBetween", () => {
  it("moves an id from one index to another (drag reorder)", () => {
    expect(moveIdBetween(["a", "b", "c", "d"], "a", "c")).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
  });

  it("returns the same array reference-shape when active === over", () => {
    expect(moveIdBetween(["a", "b"], "a", "a")).toEqual(["a", "b"]);
  });

  it("returns the input unchanged when an id is not found", () => {
    expect(moveIdBetween(["a", "b"], "missing", "a")).toEqual(["a", "b"]);
  });
});
