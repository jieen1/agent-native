import { describe, expect, it } from "vitest";

import {
  gateOverrideReviewKey,
  machineTrackAllPass,
  mergeQualityGate,
  parseSelfAssessment,
  type MachineGateItem,
} from "../quality-gate-parse.js";

describe("parseSelfAssessment", () => {
  it("parses the exact skill-authored format (key | pass|fail | evidence)", () => {
    const content = `# Sprint Doc

## Goal

Some goal text.

## 质量门自评

- goal-metrics-falsifiable | pass | M1/M2 均带 Leading/Lagging 与可证伪信号
- out-of-scope-non-empty | pass | 列出2条排除项
- p0-delete-test | fail | 未做删除测试
`;
    const items = parseSelfAssessment(content);
    expect(items).toEqual([
      {
        key: "goal-metrics-falsifiable",
        verdict: "pass",
        evidence: "M1/M2 均带 Leading/Lagging 与可证伪信号",
      },
      {
        key: "out-of-scope-non-empty",
        verdict: "pass",
        evidence: "列出2条排除项",
      },
      { key: "p0-delete-test", verdict: "fail", evidence: "未做删除测试" },
    ]);
  });

  it("returns an empty array when the section is absent", () => {
    expect(parseSelfAssessment("# Sprint Doc\n\n## Goal\n\ntext\n")).toEqual(
      [],
    );
  });

  it("stops at the next heading, not bleeding into later sections", () => {
    const content = `## 质量门自评

- a | pass | evidence a

## 其他节

- a | fail | should not be parsed
`;
    expect(parseSelfAssessment(content)).toEqual([
      { key: "a", verdict: "pass", evidence: "evidence a" },
    ]);
  });
});

describe("mergeQualityGate", () => {
  const machineItems: MachineGateItem[] = [
    { key: "m1", label: "机器项1", source: "machine", state: "pass" },
    {
      key: "m2",
      label: "机器项2",
      source: "machine",
      state: "fail",
      detail: "缺 X",
    },
  ];
  const selfItems = [
    { key: "s1", verdict: "pass" as const, evidence: "自评通过" },
    { key: "s2", verdict: "fail" as const, evidence: "自评不通过" },
  ];

  it("keeps machine items non-overridable regardless of any override signal", () => {
    const merged = mergeQualityGate(machineItems, selfItems, [
      { key: "m2", checked: true },
    ]);
    const m2 = merged.find((i) => i.key === "m2")!;
    expect(m2.track).toBe("machine");
    expect(m2.verdict).toBe("fail");
    expect(m2.overridable).toBe(false);
    expect(m2.overridden).toBe(false);
  });

  it("applies a matching gate-override signal to flip a failing self item to pass", () => {
    const merged = mergeQualityGate(machineItems, selfItems, [
      { key: "s2", checked: true },
    ]);
    const s2 = merged.find((i) => i.key === "s2")!;
    expect(s2.track).toBe("self");
    expect(s2.verdict).toBe("pass");
    expect(s2.rawVerdict).toBe("fail");
    expect(s2.overridden).toBe(true);
    expect(s2.overridable).toBe(true);
  });

  it("does not override a self item whose own verdict is already pass", () => {
    const merged = mergeQualityGate(machineItems, selfItems, [
      { key: "s1", checked: true },
    ]);
    const s1 = merged.find((i) => i.key === "s1")!;
    expect(s1.overridden).toBe(false);
    expect(s1.verdict).toBe("pass");
  });

  it("leaves a failing self item failing when no override signal is present", () => {
    const merged = mergeQualityGate(machineItems, selfItems, []);
    const s2 = merged.find((i) => i.key === "s2")!;
    expect(s2.verdict).toBe("fail");
    expect(s2.overridden).toBe(false);
  });
});

describe("machineTrackAllPass", () => {
  it("is true when every machine item passes, regardless of failing self items", () => {
    const merged = mergeQualityGate(
      [{ key: "m1", label: "m1", source: "machine", state: "pass" }],
      [{ key: "s1", verdict: "fail", evidence: "e" }],
    );
    expect(machineTrackAllPass(merged)).toBe(true);
  });

  it("is false when any machine item fails, even if all self items pass", () => {
    const merged = mergeQualityGate(
      [{ key: "m1", label: "m1", source: "machine", state: "fail" }],
      [{ key: "s1", verdict: "pass", evidence: "e" }],
    );
    expect(machineTrackAllPass(merged)).toBe(false);
  });

  it("is true (vacuously) when there are no machine items", () => {
    expect(machineTrackAllPass([])).toBe(true);
  });
});

describe("gateOverrideReviewKey", () => {
  it("builds a stable, namespaced reviewKey distinct from scenario review keys", () => {
    expect(gateOverrideReviewKey("goal-metrics-falsifiable")).toBe(
      "gate-override:goal-metrics-falsifiable",
    );
  });
});
