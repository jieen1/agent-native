import { describe, expect, it } from "vitest";

import {
  isGateCleared,
  evaluateDispatchGate,
  STAGE_ORDER,
  type DependencyStatusInput,
} from "../dispatch-gate.js";

const baseDep = (
  overrides: Partial<DependencyStatusInput>,
): DependencyStatusInput => ({
  id: "dep_001",
  itemKey: "PROJ-1",
  status: "running",
  currentStageName: "实施",
  implStageStatus: null,
  branch: null,
  ...overrides,
});

// ── isGateCleared ──────────────────────────────────────────────────────────

describe("isGateCleared", () => {
  it("status=done → gate cleared", () => {
    expect(isGateCleared(baseDep({ status: "done" }))).toBe(true);
  });

  it("status=open, stage=待办 → not cleared", () => {
    expect(
      isGateCleared(baseDep({ status: "open", currentStageName: "待办" })),
    ).toBe(false);
  });

  it("currentStageName=测试 (past 实施) → gate cleared", () => {
    expect(isGateCleared(baseDep({ currentStageName: "测试" }))).toBe(true);
  });

  it("currentStageName=验收 (past 实施) → gate cleared", () => {
    expect(isGateCleared(baseDep({ currentStageName: "验收" }))).toBe(true);
  });

  it("currentStageName=实施, implStageStatus=已完成 → gate cleared", () => {
    expect(isGateCleared(baseDep({ implStageStatus: "已完成" }))).toBe(true);
  });

  it("currentStageName=实施, implStageStatus=执行中 → not cleared", () => {
    expect(isGateCleared(baseDep({ implStageStatus: "执行中" }))).toBe(false);
  });

  it("currentStageName=实施, implStageStatus=null → not cleared", () => {
    expect(isGateCleared(baseDep({ implStageStatus: null }))).toBe(false);
  });

  it("currentStageName=设计 (before 实施) → not cleared", () => {
    expect(isGateCleared(baseDep({ currentStageName: "设计" }))).toBe(false);
  });

  it("STAGE_ORDER index check: 交付 is after 实施", () => {
    expect(isGateCleared(baseDep({ currentStageName: "交付" }))).toBe(true);
  });
});

// ── evaluateDispatchGate ──────────────────────────────────────────────────

describe("evaluateDispatchGate", () => {
  it("no dependencies → ready=true", () => {
    const result = evaluateDispatchGate([]);
    expect(result.ready).toBe(true);
    expect(result.blockedBy).toEqual([]);
    expect(result.chainedBranch).toBeNull();
  });

  it("single dependency not done → ready=false, blockedBy has 1 item", () => {
    const deps = [baseDep({ itemKey: "PROJ-1" })];
    const result = evaluateDispatchGate(deps);
    expect(result.ready).toBe(false);
    expect(result.blockedBy).toHaveLength(1);
    expect(result.blockedBy[0]!.itemKey).toBe("PROJ-1");
    expect(result.blockedBy[0]!.state).toBe("pending");
    expect(result.chainedBranch).toBeNull();
  });

  it("single dependency done via status=done → ready=true", () => {
    const deps = [baseDep({ itemKey: "PROJ-1", status: "done" })];
    const result = evaluateDispatchGate(deps);
    expect(result.ready).toBe(true);
    expect(result.blockedBy).toEqual([]);
    expect(result.chainedBranch).toBeNull();
  });

  it("single dependency done via currentStageName past 实施 → ready=true", () => {
    const deps = [baseDep({ itemKey: "PROJ-1", currentStageName: "测试" })];
    const result = evaluateDispatchGate(deps);
    expect(result.ready).toBe(true);
    expect(result.blockedBy).toEqual([]);
    expect(result.chainedBranch).toBeNull();
  });

  it("single dependency done via 实施 + stageStatus=已完成 → ready=true", () => {
    const deps = [baseDep({ itemKey: "PROJ-1", implStageStatus: "已完成" })];
    const result = evaluateDispatchGate(deps);
    expect(result.ready).toBe(true);
    expect(result.blockedBy).toEqual([]);
    expect(result.chainedBranch).toBeNull();
  });

  it("single dependency done AND has a branch → chainedBranch returns that branch (acceptance scenario: B blocked-by A only, A done)", () => {
    const deps = [
      baseDep({
        itemKey: "PROJ-1",
        status: "done",
        branch: "orchestrator/run-a-impl",
      }),
    ];
    const result = evaluateDispatchGate(deps);
    expect(result.ready).toBe(true);
    expect(result.blockedBy).toEqual([]);
    expect(result.chainedBranch).toBe("orchestrator/run-a-impl");
  });

  it("single dependency done but has no branch → chainedBranch is null", () => {
    const deps = [baseDep({ itemKey: "PROJ-1", status: "done", branch: null })];
    const result = evaluateDispatchGate(deps);
    expect(result.ready).toBe(true);
    expect(result.chainedBranch).toBeNull();
  });

  it("multiple deps, partial done → blockedBy only the pending ones", () => {
    const deps = [
      baseDep({ id: "d1", itemKey: "PROJ-3", status: "open" }),
      baseDep({ id: "d2", itemKey: "PROJ-1", status: "done" }),
      baseDep({ id: "d3", itemKey: "PROJ-2", currentStageName: "待办" }),
    ];
    const result = evaluateDispatchGate(deps);
    expect(result.ready).toBe(false);
    expect(result.blockedBy).toHaveLength(2);
    // Sorted by itemKey ascending
    expect(result.blockedBy[0]!.itemKey).toBe("PROJ-2");
    expect(result.blockedBy[1]!.itemKey).toBe("PROJ-3");
    expect(result.chainedBranch).toBeNull();
  });

  it("all deps done → chainedBranch is null (no branch chain with multiple cleared deps)", () => {
    const deps = [
      baseDep({
        id: "d1",
        itemKey: "PROJ-1",
        status: "done",
        branch: "feature/a",
      }),
      baseDep({
        id: "d2",
        itemKey: "PROJ-2",
        status: "done",
        branch: "feature/b",
      }),
    ];
    const result = evaluateDispatchGate(deps);
    expect(result.ready).toBe(true);
    expect(result.blockedBy).toEqual([]);
    expect(result.chainedBranch).toBeNull();
  });

  it("single pending dep with branch → chainedBranch returns that branch", () => {
    const deps = [baseDep({ itemKey: "PROJ-1", branch: "feature/impl" })];
    const result = evaluateDispatchGate(deps);
    expect(result.ready).toBe(false);
    expect(result.chainedBranch).toBe("feature/impl");
  });

  it("single pending dep without branch → chainedBranch is null", () => {
    const deps = [baseDep({ itemKey: "PROJ-1", branch: null })];
    const result = evaluateDispatchGate(deps);
    expect(result.ready).toBe(false);
    expect(result.chainedBranch).toBeNull();
  });

  it("multiple pending deps → chainedBranch is null even if one has a branch", () => {
    const deps = [
      baseDep({ id: "d1", itemKey: "PROJ-1", branch: "feature/a" }),
      baseDep({ id: "d2", itemKey: "PROJ-2", branch: null }),
    ];
    const result = evaluateDispatchGate(deps);
    expect(result.ready).toBe(false);
    expect(result.blockedBy).toHaveLength(2);
    expect(result.chainedBranch).toBeNull();
  });

  it("blockedBy is sorted by itemKey ascending", () => {
    const deps = [
      baseDep({ id: "a", itemKey: "PROJ-9" }),
      baseDep({ id: "b", itemKey: "PROJ-3" }),
      baseDep({ id: "c", itemKey: "PROJ-1" }),
    ];
    const result = evaluateDispatchGate(deps);
    expect(result.blockedBy.map((d) => d.itemKey)).toEqual([
      "PROJ-1",
      "PROJ-3",
      "PROJ-9",
    ]);
  });
});
