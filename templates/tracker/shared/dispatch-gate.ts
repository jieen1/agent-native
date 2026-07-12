// Shared dependency-aware dispatch gate.
// Evaluates whether a work item's upstream dependencies are satisfied before
// allowing dispatch to the orchestrator brain.

export const STAGE_ORDER: string[] = [
  "待办",
  "分析",
  "设计",
  "实施",
  "测试",
  "验收",
  "交付",
];

// Transient dependency states mapped from upstream work-item status + stage info.
// pending = upstream still in flight, fulfilled = upstream done, failed = upstream failed.
export type DependencyState = "pending" | "fulfilled" | "failed";

export interface DependencyStatusInput {
  id: string;
  itemKey: string;
  status: string;
  currentStageName: string;
  implStageStatus: string | null;
  branch: string | null;
}

export interface DependencyStatus {
  id: string;
  itemKey: string;
  state: DependencyState;
  branch: string | null;
}

export interface DispatchGateResult {
  ready: boolean;
  blockedBy: DependencyStatus[];
  chainedBranch: string | null;
}

// A single dependency is cleared when its upstream item is done, the 实施
// stage has completed (stageStatus = "已完成"), or the upstream has already
// advanced past 实施 in the stage pipeline (e.g. 测试/验收/交付).
export function isGateCleared(dep: DependencyStatusInput): boolean {
  if (dep.status === "done") return true;
  if (dep.implStageStatus === "已完成") return true;
  const implIdx = STAGE_ORDER.indexOf("实施");
  const curIdx = STAGE_ORDER.indexOf(dep.currentStageName);
  if (implIdx >= 0 && curIdx > implIdx) return true;
  return false;
}

export function evaluateDispatchGate(
  dependencies: DependencyStatusInput[],
): DispatchGateResult {
  const blockedBy: DependencyStatus[] = [];
  let chainedBranch: string | null = null;

  // chainedBranch: when exactly one dependency is provided and it carries a
  // non-empty branch, return that branch regardless of ready state. The caller
  // will only use it when ready=true.
  if (dependencies.length === 1) {
    const d = dependencies[0]!;
    if (d.branch) {
      chainedBranch = d.branch;
    }
  }

  for (const d of dependencies) {
    const cleared = isGateCleared(d);
    let state: DependencyState;
    if (cleared) {
      state = "fulfilled";
    } else if (d.status === "failed") {
      state = "failed";
    } else {
      state = "pending";
    }
    if (state !== "fulfilled") {
      blockedBy.push({ id: d.id, itemKey: d.itemKey, state, branch: d.branch });
    }
  }

  blockedBy.sort((a, b) => a.itemKey.localeCompare(b.itemKey));

  return {
    ready: blockedBy.length === 0,
    blockedBy,
    chainedBranch,
  };
}
