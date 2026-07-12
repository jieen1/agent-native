/**
 * F5 共享派发前置规模门 — docs/sdlc-impl-f5-f10.md §1(02 §3.10 拆分契约)。
 *
 * 单一事实源:**单件派发**(actions/dispatch-to-orchestrator.ts)与**批量派发**
 * (actions/bulk-dispatch-to-orchestrator.ts)必须走同一个规模门。这正是仿
 * server/lib/dispatch-gate.ts 的 `resolveDispatchGate`「一个 helper、每条派发路径
 * 都调」的共享方式 —— 建立防复发的共享基座,杜绝 F3 时代「bulk-dispatch 漏
 * 派发守卫」那类同文件同类系统盲区(SDLC-063):规模契约不再可能只活在两条
 * 派发路径中的一条。
 *
 * 纯/同步:读工作项已持久化的 scale_estimate JSON,无则现场按 brief 文本算
 * (estimateScale)。无 I/O、无数据库 —— 与 resolveDispatchGate 的异步依赖图
 * 解析不同,规模判定只依赖工作项自身的行数据,所以做成纯函数最省最稳。
 */

import { estimateScale, type ScaleEstimateResult } from "./scale-estimate.js";

/** Persisted scale_estimate JSON is a superset of the pure result (adds `at`). */
export type ScaleEstimateSnapshot = ScaleEstimateResult & { at?: string };

export interface ScaleGateResult {
  estimate: ScaleEstimateSnapshot;
  /** True when verdict==='split-required' — dispatch must be blocked unless a
   *  human explicitly overrides. */
  exceeded: boolean;
}

/**
 * Resolve the scale gate for a work-item row. Reads the persisted
 * `scale_estimate` (written by actions/estimate-brief-scale.ts) or, when
 * absent/corrupt, computes it on the fly from the item's description — the
 * SAME fallback both dispatch paths previously duplicated inline, now
 * single-sourced.
 */
export function resolveScaleGate(item: {
  scaleEstimate?: string | null;
  description?: string | null;
}): ScaleGateResult {
  let estimate: ScaleEstimateSnapshot;
  try {
    estimate = item.scaleEstimate
      ? (JSON.parse(item.scaleEstimate) as ScaleEstimateSnapshot)
      : estimateScale(item.description ?? "");
  } catch {
    estimate = estimateScale(item.description ?? "");
  }
  return { estimate, exceeded: estimate.verdict === "split-required" };
}

/** Structured error surfaced by both dispatch paths for an over-scale item.
 *  Single dispatch throws it; bulk dispatch reports its `code`/`estimate` per
 *  item — one shape, both paths. */
export interface ScaleExceededError extends Error {
  code: "scale-exceeded";
  estimate: ScaleEstimateSnapshot;
  suggestion: "split-work-item";
}

/** Build the canonical scale-exceeded error (identical message + structured
 *  fields for the single-dispatch throw and the bulk-dispatch per-item skip). */
export function scaleExceededError(
  estimate: ScaleEstimateSnapshot,
): ScaleExceededError {
  const err = new Error(
    `工作项规模预估超过单节点阈值(${estimate.files} 文件` +
      `${estimate.crossLifecycle ? " · 跨生命周期协同" : ""})——` +
      `建议先用 split-work-item 拆分,或显式传 overrideScale:true 人工覆盖`,
  ) as ScaleExceededError;
  err.code = "scale-exceeded";
  err.estimate = estimate;
  err.suggestion = "split-work-item";
  return err;
}
