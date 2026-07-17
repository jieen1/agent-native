import { describe, expect, it } from "vitest";

import {
  allMachineGatesPass,
  assembleArtifactGates,
} from "../artifact-gates.js";

describe("assembleArtifactGates — brainstorm-notes", () => {
  it("has no hard gate (§5.2: optional step)", () => {
    expect(assembleArtifactGates("brainstorm-notes", "anything")).toEqual([]);
  });
});

describe("assembleArtifactGates — sprint-doc", () => {
  const GOOD_DOC = `# Sprint Doc

## Goal

提升队列吞吐

## Success Metrics

- M1 | Leading | 队列平均等待时间下降 | 队列面板 P95 读数
- M2 | Lagging | 月度吞吐提升 10% | 分析平台报表

## In-Scope

- O1: 支持拖拽重排序
- O2: 展示预计等待时间

## Out-of-Scope

- 不支持跨项目批量重排序
`;

  it("passes all machine items on a well-formed doc, and always flags the delete-test as needs-human", () => {
    const items = assembleArtifactGates("sprint-doc", GOOD_DOC);
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(byKey["goal-metrics-falsifiable"]!.state).toBe("pass");
    expect(byKey["out-of-scope-non-empty"]!.state).toBe("pass");
    expect(byKey["no-file-paths-or-code"]!.state).toBe("pass");
    expect(byKey["p0-delete-test"]!.source).toBe("human");
    expect(byKey["p0-delete-test"]!.state).toBe("needs-human");
    expect(allMachineGatesPass(items)).toBe(true);
  });

  it("fails goal-metrics when Success Metrics is missing", () => {
    const doc = GOOD_DOC.replace(
      /## Success Metrics[\s\S]*?(?=## In-Scope)/,
      "",
    );
    const items = assembleArtifactGates("sprint-doc", doc);
    const item = items.find((i) => i.key === "goal-metrics-falsifiable")!;
    expect(item.state).toBe("fail");
    expect(item.source).toBe("machine");
  });

  it("fails out-of-scope-non-empty when the section is empty", () => {
    const doc = GOOD_DOC.replace(/## Out-of-Scope[\s\S]*/, "## Out-of-Scope\n");
    const items = assembleArtifactGates("sprint-doc", doc);
    expect(items.find((i) => i.key === "out-of-scope-non-empty")!.state).toBe(
      "fail",
    );
  });

  it("fails no-file-paths-or-code when a code block or file path leaks in", () => {
    const withCode = GOOD_DOC + "\n```ts\nconst x = 1;\n```\n";
    expect(
      assembleArtifactGates("sprint-doc", withCode).find(
        (i) => i.key === "no-file-paths-or-code",
      )!.state,
    ).toBe("fail");

    const withPath =
      GOOD_DOC + "\n参见 server/lib/scale-estimate.ts 的实现。\n";
    expect(
      assembleArtifactGates("sprint-doc", withPath).find(
        (i) => i.key === "no-file-paths-or-code",
      )!.state,
    ).toBe("fail");
  });
});

describe("assembleArtifactGates — test-plan", () => {
  const GOOD_DOC = `## 场景

### 场景 1 · 拖拽重排序成功

- **Why**: 验证核心交互
- **Steps**: 拖拽第 2 项到第 1 位
- **Expected**: 顺序持久化
- **Pass-fail 信号**: exec_queue.position 更新且刷新后顺序不变
- **执行工具**: playwright
- **关联指标**: M1

### 场景 2 · 超时提醒展示

- **Why**: 验证依赖 ETA
- **Steps**: 排队超过阈值
- **Expected**: 显示提醒
- **Pass-fail 信号**: 提醒文案出现且倒计时不为负
- **执行工具**: playwright
- **关联指标**: M1, M2
`;

  it("passes when every scenario has a falsifiable signal and a valid metric ref", () => {
    const items = assembleArtifactGates("test-plan", GOOD_DOC);
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(byKey["scenario-falsifiable-signal"]!.state).toBe("pass");
    expect(byKey["black-box-language"]!.state).toBe("pass");
    expect(byKey["metrics-linked"]!.state).toBe("pass");
  });

  it("fails scenario-falsifiable-signal when Pass-fail 信号 is missing", () => {
    const doc = GOOD_DOC.replace(/- \*\*Pass-fail 信号\*\*:.*\n/, "");
    const items = assembleArtifactGates("test-plan", doc);
    expect(
      items.find((i) => i.key === "scenario-falsifiable-signal")!.state,
    ).toBe("fail");
  });

  it("fails black-box-language when a scenario leaks a code span", () => {
    const doc = GOOD_DOC.replace(
      "验证核心交互",
      "验证核心交互，检查 `reorderQueue()` 内部调用",
    );
    const items = assembleArtifactGates("test-plan", doc);
    expect(items.find((i) => i.key === "black-box-language")!.state).toBe(
      "fail",
    );
  });

  it("fails metrics-linked when 关联指标 is missing or malformed", () => {
    const missing = GOOD_DOC.replace(
      /- \*\*关联指标\*\*: M1\n/,
      "- **关联指标**: 无\n",
    );
    expect(
      assembleArtifactGates("test-plan", missing).find(
        (i) => i.key === "metrics-linked",
      )!.state,
    ).toBe("fail");

    const malformed = GOOD_DOC.replace(
      "关联指标**: M1\n",
      "关联指标**: metric-one\n",
    );
    expect(
      assembleArtifactGates("test-plan", malformed).find(
        (i) => i.key === "metrics-linked",
      )!.state,
    ).toBe("fail");
  });

  it("passes trivially when a sprint declares no cross-module scenarios", () => {
    const doc =
      "## 无集成场景声明\n\n本 sprint 所有变更均为单模块内部改动，无跨模块场景。\n";
    const items = assembleArtifactGates("test-plan", doc);
    expect(items.every((i) => i.state === "pass")).toBe(true);
  });

  it("fails when there are no scenarios and no exemption declaration", () => {
    const items = assembleArtifactGates("test-plan", "# empty doc\n");
    expect(
      items.find((i) => i.key === "scenario-falsifiable-signal")!.state,
    ).toBe("fail");
  });
});

describe("assembleArtifactGates — ui-spec", () => {
  const SPRINT_DOC = `## In-Scope

- O1: 支持拖拽重排序
- O2: 展示预计等待时间
- O3: 后台定时清理过期队列项
`;

  const GOOD_UI_SPEC = `## 屏清单

- S1 · 队列页
- S2 · 详情页

## 无界面 Outcomes

- O3: 纯后端定时任务，无用户可见界面

## 逐屏规格

### S1 · 队列页

- **目标**: 展示队列
- **主操作**: 拖拽重排序
- **数据状态**: 空/加载/正常
- **空态**: 无排队项
- **关联 Outcome**: O1

### S2 · 详情页

- **目标**: 展示 ETA
- **主操作**: 无
- **数据状态**: 正常
- **空态**: 无
- **关联 Outcome**: O2
`;

  it("passes when every In-Scope outcome maps to a screen or 无界面", () => {
    const items = assembleArtifactGates("ui-spec", GOOD_UI_SPEC, {
      sprintDocContent: SPRINT_DOC,
    });
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(byKey["outcomes-mapped-to-screens"]!.state).toBe("pass");
    expect(byKey["screen-ids-stable"]!.state).toBe("pass");
  });

  it("fails outcomes-mapped-to-screens when an In-Scope outcome is unmapped", () => {
    const missing = GOOD_UI_SPEC.replace(
      "- O3: 纯后端定时任务，无用户可见界面\n",
      "",
    );
    const items = assembleArtifactGates("ui-spec", missing, {
      sprintDocContent: SPRINT_DOC,
    });
    const item = items.find((i) => i.key === "outcomes-mapped-to-screens")!;
    expect(item.state).toBe("fail");
    expect(item.detail).toContain("O3");
  });

  it("marks outcomes-mapped-to-screens as needs-human when sprint-doc is unavailable", () => {
    const items = assembleArtifactGates("ui-spec", GOOD_UI_SPEC);
    const item = items.find((i) => i.key === "outcomes-mapped-to-screens")!;
    expect(item.source).toBe("human");
    expect(item.state).toBe("needs-human");
  });

  it("fails screen-ids-stable when screen numbering has a gap", () => {
    const doc = GOOD_UI_SPEC.replace("- S2 · 详情页", "- S3 · 详情页");
    const items = assembleArtifactGates("ui-spec", doc, {
      sprintDocContent: SPRINT_DOC,
    });
    expect(items.find((i) => i.key === "screen-ids-stable")!.state).toBe(
      "fail",
    );
  });
});

describe("assembleArtifactGates — tech-design", () => {
  const UI_SPEC = "## 屏清单\n\n- S1 · 队列页\n";
  const GOOD_TECH_DESIGN = `## §4 工作项设计

### §4.1 PRJ-001 · 队列重排序（见 S1）

body

## §7 文件变更矩阵

| 文件路径 | 操作 | 所属工作项 | 说明 | 依赖文件 |
| --- | --- | --- | --- | --- |
| \`actions/reorder-queue.ts\` | MODIFY | PRJ-001 | 持久化顺序 | |
`;

  it("passes section-count/file-matrix/screen-refs/path-consistency on a well-formed doc", () => {
    const items = assembleArtifactGates("tech-design", GOOD_TECH_DESIGN, {
      uiSpecContent: UI_SPEC,
      sprintWorkItemCount: 1,
    });
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(byKey["section-count-matches-items"]!.state).toBe("pass");
    expect(byKey["file-matrix-parseable"]!.state).toBe("pass");
    expect(byKey["ui-spec-screen-refs-exist"]!.state).toBe("pass");
    expect(byKey["file-path-format-consistency"]!.state).toBe("pass");
  });

  it("fails section-count-matches-items when §4 count differs from sprint work-item count", () => {
    const items = assembleArtifactGates("tech-design", GOOD_TECH_DESIGN, {
      uiSpecContent: UI_SPEC,
      sprintWorkItemCount: 2,
    });
    expect(
      items.find((i) => i.key === "section-count-matches-items")!.state,
    ).toBe("fail");
  });

  it("marks section-count-matches-items as needs-human without a work-item count", () => {
    const items = assembleArtifactGates("tech-design", GOOD_TECH_DESIGN, {
      uiSpecContent: UI_SPEC,
    });
    const item = items.find((i) => i.key === "section-count-matches-items")!;
    expect(item.source).toBe("human");
  });

  it("fails file-matrix-parseable when §7 is missing or has an invalid operation", () => {
    const noMatrix = "## §4 工作项设计\n\n### §4.1 PRJ-001 · x\n\nbody\n";
    expect(
      assembleArtifactGates("tech-design", noMatrix, {
        sprintWorkItemCount: 1,
      }).find((i) => i.key === "file-matrix-parseable")!.state,
    ).toBe("fail");

    const badOp = GOOD_TECH_DESIGN.replace("MODIFY", "REFACTOR");
    expect(
      assembleArtifactGates("tech-design", badOp, {
        uiSpecContent: UI_SPEC,
        sprintWorkItemCount: 1,
      }).find((i) => i.key === "file-matrix-parseable")!.state,
    ).toBe("fail");
  });

  it("fails ui-spec-screen-refs-exist when a referenced screen id doesn't exist in ui-spec", () => {
    const doc = GOOD_TECH_DESIGN.replace("S1", "S9");
    const items = assembleArtifactGates("tech-design", doc, {
      uiSpecContent: UI_SPEC,
      sprintWorkItemCount: 1,
    });
    expect(
      items.find((i) => i.key === "ui-spec-screen-refs-exist")!.state,
    ).toBe("fail");
  });

  it("passes ui-spec-screen-refs-exist trivially when no screen is referenced", () => {
    const doc = GOOD_TECH_DESIGN.replace("（见 S1）", "");
    const items = assembleArtifactGates("tech-design", doc, {
      sprintWorkItemCount: 1,
    });
    expect(
      items.find((i) => i.key === "ui-spec-screen-refs-exist")!.state,
    ).toBe("pass");
  });

  it("fails file-path-format-consistency when §4 mentions a path absent from §7", () => {
    const doc = GOOD_TECH_DESIGN.replace(
      "body",
      "body，另涉及 `server/lib/queue-eta.ts`",
    );
    const items = assembleArtifactGates("tech-design", doc, {
      uiSpecContent: UI_SPEC,
      sprintWorkItemCount: 1,
    });
    expect(
      items.find((i) => i.key === "file-path-format-consistency")!.state,
    ).toBe("fail");
  });
});

describe("assembleArtifactGates — unspecified docKey fallback", () => {
  it("returns a single placeholder non-empty-content machine check", () => {
    const items = assembleArtifactGates("story", "some content");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: "machine", state: "pass" });

    const empty = assembleArtifactGates("verify-report", "   ");
    expect(empty[0]!.state).toBe("fail");
  });

  it("applies the same fallback to dynamic brief:{itemKey} docKeys", () => {
    const items = assembleArtifactGates("brief:PRJ-001", "brief body");
    expect(items[0]!.state).toBe("pass");
  });
});

describe("allMachineGatesPass", () => {
  it("ignores human-source items entirely", () => {
    const items = [
      {
        key: "a",
        label: "a",
        source: "machine" as const,
        state: "pass" as const,
      },
      {
        key: "b",
        label: "b",
        source: "human" as const,
        state: "needs-human" as const,
      },
    ];
    expect(allMachineGatesPass(items)).toBe(true);
  });

  it("is false when any machine item fails", () => {
    const items = [
      {
        key: "a",
        label: "a",
        source: "machine" as const,
        state: "fail" as const,
      },
      {
        key: "b",
        label: "b",
        source: "human" as const,
        state: "needs-human" as const,
      },
    ];
    expect(allMachineGatesPass(items)).toBe(false);
  });
});
