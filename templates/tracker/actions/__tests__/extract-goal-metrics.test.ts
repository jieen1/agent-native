import { describe, expect, it } from "vitest";

import {
  extractSuccessMetricsSection,
  parseSuccessMetrics,
  assertArtifactFound,
} from "../extract-goal-metrics.js";

const sampleDoc = `# Sprint Doc

## Goal

提升结账转化率

## Success Metrics

- M1 | Leading | 结账页错误率下降 | 错误率监控面板每日读数
- M2 | Lagging | 月度结账转化率提升2个百分点 | 分析平台转化率报表
- M3 | Leading | 首屏加载时间低于1.5秒 | 前端性能监控P95延迟
- 这是一条没有编号的说明性文字，不应计入指标

## Notes

其他内容不应被解析进指标。
`;

describe("extractSuccessMetricsSection", () => {
  it("returns lines inside Success Metrics section, not including other sections", () => {
    const lines = extractSuccessMetricsSection(sampleDoc);
    expect(lines).not.toBeNull();
    expect(lines!.some((l) => l.includes("M1"))).toBe(true);
    expect(lines!.some((l) => l.includes("其他内容"))).toBe(false);
  });

  it("returns null when Success Metrics heading is absent", () => {
    const doc = "# Some Doc\n\n## Other Section\n\n- foo\n";
    expect(extractSuccessMetricsSection(doc)).toBeNull();
  });
});

describe("parseSuccessMetrics", () => {
  it("parses three metrics and one warning from the sample doc", () => {
    const result = parseSuccessMetrics(sampleDoc);
    expect(result.metrics).toEqual([
      {
        id: "M1",
        type: "Leading",
        statement: "结账页错误率下降",
        signal: "错误率监控面板每日读数",
      },
      {
        id: "M2",
        type: "Lagging",
        statement: "月度结账转化率提升2个百分点",
        signal: "分析平台转化率报表",
      },
      {
        id: "M3",
        type: "Leading",
        statement: "首屏加载时间低于1.5秒",
        signal: "前端性能监控P95延迟",
      },
    ]);
    expect(result.warnings).toEqual([
      "这是一条没有编号的说明性文字，不应计入指标",
    ]);
  });

  it("is deterministic: two calls on the same input produce identical JSON", () => {
    const r1 = parseSuccessMetrics(sampleDoc);
    const r2 = parseSuccessMetrics(sampleDoc);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it("returns empty metrics and a fixed warning when Success Metrics heading is missing", () => {
    const doc = "# Doc\n\n## Something Else\n\n- M1 | Leading | x | y\n";
    const result = parseSuccessMetrics(doc);
    expect(result.metrics).toEqual([]);
    expect(result.warnings).toEqual(["Success Metrics 节未找到"]);
  });

  it("ignores blank lines inside the section", () => {
    const doc = `# Doc

## Success Metrics

- M1 | Leading | statement1 | signal1

- M2 | Lagging | statement2 | signal2

`;
    const result = parseSuccessMetrics(doc);
    expect(result.metrics.length).toBe(2);
    expect(result.warnings).toEqual([]);
  });
});

describe("assertArtifactFound", () => {
  it("throws when artifact is undefined", () => {
    expect(() => assertArtifactFound(undefined, "spr_123")).toThrow(
      "未找到 sprint spr_123 的 sprint-doc 产物（docKey=sprint-doc）",
    );
  });

  it("returns the artifact unchanged when present", () => {
    const obj = { content: "hello" };
    expect(assertArtifactFound(obj, "spr_123")).toBe(obj);
  });
});
