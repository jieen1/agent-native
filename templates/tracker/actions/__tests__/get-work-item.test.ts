import { describe, expect, it } from "vitest";
import { shapeWorkItemDetail } from "../get-work-item.js";

function baseItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "wi1",
    projectId: "p1",
    type: "task",
    title: "t",
    description: "",
    status: "open",
    priority: 2,
    orchestratorThreadId: null,
    orchestratorTaskId: null,
    orchestratorRunId: null,
    orchestratorWorkspaceId: null,
    dispatchedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    sprintId: null,
    itemKey: "T-1",
    risk: "medium",
    tags: "[]",
    executionMode: "manual",
    currentStageName: "待办",
    plannedStages: "[]",
    branch: null,
    owner: null,
    nature: "[]",
    ...overrides,
  } as any;
}

describe("shapeWorkItemDetail", () => {
  it("returns owner=null and nature=[] when unset", () => {
    const out = shapeWorkItemDetail(baseItem(), null, null);
    expect(out.owner).toBe(null);
    expect(out.nature).toEqual([]);
  });

  it("returns a real owner email", () => {
    const out = shapeWorkItemDetail(
      baseItem({ owner: "alice@example.com" }),
      null,
      null,
    );
    expect(out.owner).toBe("alice@example.com");
  });

  it("returns owner='agent' for agent assignment", () => {
    const out = shapeWorkItemDetail(baseItem({ owner: "agent" }), null, null);
    expect(out.owner).toBe("agent");
  });

  it("parses a nature JSON array", () => {
    const out = shapeWorkItemDetail(
      baseItem({ nature: JSON.stringify(["后端", "API"]) }),
      null,
      null,
    );
    expect(out.nature).toEqual(["后端", "API"]);
  });

  it("falls back to [] for malformed nature JSON", () => {
    const out = shapeWorkItemDetail(
      baseItem({ nature: "not json" }),
      null,
      null,
    );
    expect(out.nature).toEqual([]);
  });

  it("still returns existing fields like tags/plannedStages unchanged", () => {
    const out = shapeWorkItemDetail(
      baseItem({
        tags: JSON.stringify(["x"]),
        plannedStages: JSON.stringify(["分析"]),
      }),
      null,
      null,
    );
    expect(out.tags).toEqual(["x"]);
    expect(out.plannedStages).toEqual(["分析"]);
  });

  // F5 (v25): scaleEstimate/splitParentId.
  it("returns scaleEstimate=null and splitParentId=null when unset", () => {
    const out = shapeWorkItemDetail(baseItem(), null, null);
    expect(out.scaleEstimate).toBe(null);
    expect(out.splitParentId).toBe(null);
  });

  it("parses a persisted scaleEstimate JSON string into an object", () => {
    const out = shapeWorkItemDetail(
      baseItem({
        scaleEstimate: JSON.stringify({
          files: 8,
          crossLifecycle: false,
          verdict: "split-required",
          signals: [],
        }),
      }),
      null,
      null,
    );
    expect(out.scaleEstimate).toEqual({
      files: 8,
      crossLifecycle: false,
      verdict: "split-required",
      signals: [],
    });
  });

  it("falls back to null for malformed scaleEstimate JSON", () => {
    const out = shapeWorkItemDetail(
      baseItem({ scaleEstimate: "not json" }),
      null,
      null,
    );
    expect(out.scaleEstimate).toBe(null);
  });

  it("returns splitParentId when the item is a split child", () => {
    const out = shapeWorkItemDetail(
      baseItem({ splitParentId: "wi_parent" }),
      null,
      null,
    );
    expect(out.splitParentId).toBe("wi_parent");
  });

  // ==========================================================================
  // F8: itemKeyDisplay + runs — extra param is optional (existing callers
  // above that omit it keep working: itemKeyDisplay falls back to the raw
  // itemKey, runs falls back to []).
  // ==========================================================================
  it("F8: without `extra`, itemKeyDisplay falls back to the raw itemKey and runs is []", () => {
    const out = shapeWorkItemDetail(baseItem({ itemKey: "T-7" }), null, null);
    expect(out.itemKeyDisplay).toBe("T-7");
    expect(out.runs).toEqual([]);
  });

  it("F8: with `extra`, itemKeyDisplay and runs come from the caller's computed values", () => {
    const runs = [
      { runId: "run_1", threadId: "bt_1", branch: "orchestrator/x", dispatchedAt: "2026-01-02T00:00:00Z", superseded: false },
      { runId: null, threadId: "bt_0", branch: null, dispatchedAt: "2026-01-01T00:00:00Z", superseded: true },
    ];
    const out = shapeWorkItemDetail(baseItem({ itemKey: "T-7" }), null, null, undefined, {
      itemKeyDisplay: "T-7·ab12",
      runs,
    });
    expect(out.itemKeyDisplay).toBe("T-7·ab12");
    expect(out.runs).toEqual(runs);
    // Raw itemKey is untouched — extra only adds the display field, it
    // doesn't overwrite the underlying data.
    expect(out.itemKey).toBe("T-7");
  });
});
