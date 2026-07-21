import { describe, expect, it } from "vitest";

import { buildDraftChildren, canSubmitSplit } from "../split-draft.js";

// ============================================================================
// T-F5-08 阶段 A: S2 拆分对话框交互逻辑(原型 file:// 已备 —
// docs/sdlc-product-design/prototypes/s2-sprint-studio.html 的
// x-data="{dlg:false,rows:[...],chain:true}" 块与本文件的纯逻辑一一对应:
// `:disabled="rows.length<2 || rows.some(r=>!r.t.trim())"` ==
// `!canSubmitSplit(rows)`)。
//
// This template's test suite is logic-only (no jsdom/RTL harness — see
// app/pages/__tests__/sprint.test.ts) so Stage A here covers the pure
// helpers a real SplitWorkItemDialog component consumes
// (app/pages/WorkItemDetailPage.tsx's SplitWorkItemDialog), not a mounted
// component render. Stage B (real page Playwright) is NOT covered by this
// task — see the final report's honest T-F5 coverage table.
// ============================================================================

describe("T-F5-08 阶段 A: canSubmitSplit(≥2 行且 title 非空才可提交)", () => {
  it("少于 2 行 → 不可提交", () => {
    expect(canSubmitSplit([{ title: "A" }])).toBe(false);
    expect(canSubmitSplit([])).toBe(false);
  });

  it("≥2 行且全部 title 非空 → 可提交", () => {
    expect(canSubmitSplit([{ title: "A" }, { title: "B" }])).toBe(true);
    expect(
      canSubmitSplit([{ title: "A" }, { title: "B" }, { title: "C" }]),
    ).toBe(true);
  });

  it("任一行 title 为空(或纯空白)→ 置灰,不可提交", () => {
    expect(canSubmitSplit([{ title: "A" }, { title: "" }])).toBe(false);
    expect(canSubmitSplit([{ title: "A" }, { title: "   " }])).toBe(false);
  });
});

describe("T-F5-08 阶段 A: buildDraftChildren(按文件簇分组预填 ≤6 文件/组)", () => {
  it("12 个 file: signal → 2 组预填草稿(每组 ≤6)", () => {
    const signals = Array.from(
      { length: 12 },
      (_, i) => `file:server/lib/f${i}.ts`,
    );
    const rows = buildDraftChildren(signals);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.description.split(", ")).toHaveLength(6);
    expect(rows[1]!.description.split(", ")).toHaveLength(6);
  });

  it("7 个 file: signal → 2 组(6 + 1)", () => {
    const signals = Array.from({ length: 7 }, (_, i) => `file:a/${i}.ts`);
    const rows = buildDraftChildren(signals);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.description.split(", ")).toHaveLength(6);
    expect(rows[1]!.description.split(", ")).toHaveLength(1);
  });

  it("无 file: signal(纯 crossLifecycle 触发)→ 仍返回 ≥2 空草稿行供手填", () => {
    const rows = buildDraftChildren([
      "lifecycle:schema-migration",
      "lifecycle:action",
    ]);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.description === "")).toBe(true);
  });

  it("ignores non-file: signals when clustering", () => {
    const signals = ["lifecycle:action", "file:a.ts", "file:b.ts", "file:c.ts"];
    const rows = buildDraftChildren(signals);
    const allDescriptions = rows.map((r) => r.description).join(",");
    expect(allDescriptions).not.toContain("lifecycle:");
  });
});
