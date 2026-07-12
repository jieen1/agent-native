import { describe, expect, it } from "vitest";
import { estimateScale } from "../scale-estimate.js";

// ============================================================================
// T-F5-01: estimateScale 纯函数 — docs/sdlc-impl-f5-f10.md §1E
//
// "test.each: 6 组固定 brief 文本(3/6/7/12 文件、跨生命周期、零路径) →
// files/crossLifecycle/verdict 与期望逐项相等;7 文件与跨生命周期均
// split-required"
// ============================================================================

const THREE_FILES = `
新增支付对账导出功能。涉及文件:
- \`server/lib/reconcile-export.ts\`
- \`actions/export-reconciliation.ts\`
- \`app/pages/ReconcilePage.tsx\`
`;

const SIX_FILES = `
批量导出重构,涉及:
- \`server/lib/export-jobs.ts\`
- \`server/lib/export-runner.ts\`
- \`actions/create-export-job.ts\`
- \`actions/list-export-jobs.ts\`
- \`app/pages/ExportJobsPage.tsx\`
- \`app/hooks/use-export-jobs.ts\`
`;

const SEVEN_FILES = `
七个文件的改动:
- \`server/lib/a.ts\`
- \`server/lib/b.ts\`
- \`server/lib/c.ts\`
- \`actions/d.ts\`
- \`actions/e.ts\`
- \`app/pages/F.tsx\`
- \`app/pages/G.tsx\`
`;

const TWELVE_FILES = `
PAY-210 批量导出:12 个文件——
- \`server/db/schema.ts\`
- \`server/plugins/db.ts\`
- \`server/lib/export-jobs.ts\`
- \`server/lib/export-runner.ts\`
- \`server/lib/export-retry.ts\`
- \`actions/create-export-job.ts\`
- \`actions/list-export-jobs.ts\`
- \`actions/retry-export-job.ts\`
- \`app/pages/ExportJobsPage.tsx\`
- \`app/pages/ExportJobDetailPage.tsx\`
- \`app/hooks/use-export-jobs.ts\`
- \`app/components/ExportStatusBadge.tsx\`
`;

// Cross-lifecycle: only 2 files (well under the >6 threshold) but the brief
// text co-occurs schema/迁移 + action + 页面/组件 + 调度器/插件 keywords —
// verdict must still be split-required purely off the crossLifecycle signal.
const CROSS_LIFECYCLE = `
需要新增 schema 迁移(tracker_export_jobs 表),配套一个 action
(create-export-job),一个页面组件展示进度,并接入调度器插件按 cron
轮询重试。涉及文件:
- \`server/db/schema.ts\`
- \`actions/create-export-job.ts\`
`;

const ZERO_PATHS = `
优化导出体验的措辞和文案,不涉及具体代码文件改动,纯粹是产品讨论。
`;

describe("T-F5-01: estimateScale 纯函数", () => {
  it.each([
    [
      "3 文件",
      THREE_FILES,
      { files: 3, crossLifecycle: false, verdict: "ok" as const },
    ],
    [
      "6 文件(边界,不超标)",
      SIX_FILES,
      { files: 6, crossLifecycle: false, verdict: "ok" as const },
    ],
    [
      "7 文件(超标)",
      SEVEN_FILES,
      { files: 7, crossLifecycle: false, verdict: "split-required" as const },
    ],
    [
      "12 文件(超标)",
      TWELVE_FILES,
      { files: 12, crossLifecycle: false, verdict: "split-required" as const },
    ],
    [
      "跨生命周期(文件数不超标但 crossLifecycle 触发)",
      CROSS_LIFECYCLE,
      { files: 2, crossLifecycle: true, verdict: "split-required" as const },
    ],
    [
      "零路径",
      ZERO_PATHS,
      { files: 0, crossLifecycle: false, verdict: "ok" as const },
    ],
  ])("%s", (_label, text, expected) => {
    const result = estimateScale(text);
    expect(result.files).toBe(expected.files);
    expect(result.crossLifecycle).toBe(expected.crossLifecycle);
    expect(result.verdict).toBe(expected.verdict);
  });

  it("7 文件与跨生命周期均判定 split-required(阈值 >6 二选一触发)", () => {
    expect(estimateScale(SEVEN_FILES).verdict).toBe("split-required");
    expect(estimateScale(CROSS_LIFECYCLE).verdict).toBe("split-required");
  });

  it("deduplicates repeated backtick paths (same path referenced twice counts once)", () => {
    const text = "见 `server/lib/foo.ts` 与再次提及的 `server/lib/foo.ts`。";
    expect(estimateScale(text).files).toBe(1);
  });

  it("is deterministic — same input always yields the same output (T-F5-02 依赖)", () => {
    const a = estimateScale(TWELVE_FILES);
    const b = estimateScale(TWELVE_FILES);
    expect(a).toEqual(b);
  });

  it("signals carries file: and lifecycle: entries for UI consumption", () => {
    const result = estimateScale(CROSS_LIFECYCLE);
    expect(result.signals).toContain("file:server/db/schema.ts");
    expect(result.signals).toContain("file:actions/create-export-job.ts");
    expect(result.signals.some((s) => s.startsWith("lifecycle:"))).toBe(true);
  });

  it("handles null/undefined brief text without throwing", () => {
    expect(estimateScale(null).files).toBe(0);
    expect(estimateScale(undefined).verdict).toBe("ok");
  });
});
