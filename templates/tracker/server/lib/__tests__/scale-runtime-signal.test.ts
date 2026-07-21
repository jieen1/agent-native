import { describe, expect, it } from "vitest";

import {
  applyRuntimeExhaustion,
  shouldMarkScaleExceeded,
  RUNTIME_EXHAUSTION_THRESHOLD,
} from "../scale-runtime-signal.js";

// Not one of T-F5-01..08 (those cover estimate/dispatch/split/migration/UI —
// see docs/sdlc-impl-f5-f10.md §1E's explicit "改动↔用例对账"). This is
// supplementary coverage for the pure-judgment half of
// server/lib/scale-runtime-signal.ts (the DB-touching markScaleExceeded()
// half is exercised indirectly through actions/mark-scale-exceeded.ts, which
// has no dedicated T-F5 slot either — see the final report's honest
// coverage table for this gap).
describe("scale-runtime-signal 纯判定(补充覆盖,非 T-F5-01..08 编号内)", () => {
  it("shouldMarkScaleExceeded: 阈值前 false,阈值及以上 true", () => {
    expect(shouldMarkScaleExceeded(RUNTIME_EXHAUSTION_THRESHOLD - 1)).toBe(
      false,
    );
    expect(shouldMarkScaleExceeded(RUNTIME_EXHAUSTION_THRESHOLD)).toBe(true);
    expect(shouldMarkScaleExceeded(RUNTIME_EXHAUSTION_THRESHOLD + 5)).toBe(
      true,
    );
  });

  it("applyRuntimeExhaustion: 未达阈值时原样返回(不覆盖既有 ok)", () => {
    const existing = {
      files: 2,
      crossLifecycle: false,
      signals: [],
      verdict: "ok" as const,
    };
    expect(applyRuntimeExhaustion(existing, 1)).toEqual(existing);
  });

  it("applyRuntimeExhaustion: 达阈值时覆盖为 split-required 并追加 runtime 信号", () => {
    const existing = {
      files: 2,
      crossLifecycle: false,
      signals: [],
      verdict: "ok" as const,
    };
    const result = applyRuntimeExhaustion(existing, 2);
    expect(result.verdict).toBe("split-required");
    expect(result.signals).toContain("runtime:budget-exhausted");
  });

  it("applyRuntimeExhaustion: 已是 split-required 时不重复追加信号", () => {
    const existing = {
      files: 8,
      crossLifecycle: false,
      signals: ["runtime:budget-exhausted"],
      verdict: "split-required" as const,
    };
    const result = applyRuntimeExhaustion(existing, 3);
    expect(result.signals).toEqual(["runtime:budget-exhausted"]);
  });

  it("applyRuntimeExhaustion: 无既有估算时以空白 ok 为基线", () => {
    const result = applyRuntimeExhaustion(null, 2);
    expect(result.verdict).toBe("split-required");
  });
});
