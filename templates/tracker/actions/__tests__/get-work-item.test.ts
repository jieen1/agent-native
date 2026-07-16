import { describe, expect, it } from "vitest";
import { legacyRunFallback, shapeWorkItemDetail } from "../get-work-item.js";

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

  // ==========================================================================
  // Regression: SDLC-040/041/043 were confirmed on production to have real,
  // completed v3_runs (with real DAG nodes) yet get-work-item.runs came back
  // [] — these items were dispatched before tracker_work_item_runs (F8,
  // SDLC-053) started recording history, so `listWorkItemRuns` legitimately
  // finds no row, and RunEvidenceList (gated on `runs.length === 0`) rendered
  // nothing. legacyRunFallback synthesizes a run summary from the pre-F8
  // columns that were already being populated (orchestratorThreadId/
  // orchestratorRunId/branch/dispatchedAt) so dispatched-but-never-backfilled
  // items still surface their one known run.
  // ==========================================================================
  describe("legacyRunFallback", () => {
    it("returns [] for an item that was never dispatched", () => {
      expect(legacyRunFallback(baseItem())).toEqual([]);
    });

    it("synthesizes a single non-superseded run from legacy columns when dispatched", () => {
      const out = legacyRunFallback(
        baseItem({
          orchestratorThreadId: "bt_1",
          orchestratorRunId: "v3r_1",
          branch: "orchestrator/run-abc",
          dispatchedAt: "2026-07-11T05:00:21.059Z",
        }),
      );
      expect(out).toEqual([
        {
          runId: "v3r_1",
          threadId: "bt_1",
          branch: "orchestrator/run-abc",
          dispatchedAt: "2026-07-11T05:00:21.059Z",
          superseded: false,
        },
      ]);
    });

    it("tolerates a dispatched item whose runId/branch never backfilled (still null)", () => {
      const out = legacyRunFallback(
        baseItem({
          orchestratorThreadId: "bt_1",
          orchestratorRunId: null,
          branch: null,
          dispatchedAt: "2026-07-11T04:07:50.872Z",
        }),
      );
      expect(out).toEqual([
        {
          runId: null,
          threadId: "bt_1",
          branch: null,
          dispatchedAt: "2026-07-11T04:07:50.872Z",
          superseded: false,
        },
      ]);
    });

    it("falls back to updatedAt when dispatchedAt itself is missing", () => {
      const out = legacyRunFallback(
        baseItem({
          orchestratorThreadId: "bt_1",
          dispatchedAt: null,
          updatedAt: "2026-07-12T00:00:00Z",
        }),
      );
      expect(out[0]?.dispatchedAt).toBe("2026-07-12T00:00:00Z");
    });
  });
});
