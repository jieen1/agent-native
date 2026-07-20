import { describe, expect, it } from "vitest";

import {
  deriveStudioSteps,
  hasUiShapedInScope,
  type DeriveStudioStepsInput,
} from "../studio-step-derive.js";

function baseInput(
  overrides: Partial<DeriveStudioStepsInput> = {},
): DeriveStudioStepsInput {
  return {
    artifacts: {},
    activeStep: null,
    inScopeOutcomes: [],
    stepOverrides: {},
    ...overrides,
  };
}

describe("deriveStudioSteps — 已定稿 (final)", () => {
  it("marks a step final once its docKey has a latest artifact version", () => {
    const steps = deriveStudioSteps(
      baseInput({
        artifacts: { "sprint-doc": { latestVersion: 2 } },
      }),
    );
    const step2 = steps.find((s) => s.step === 2)!;
    expect(step2.state).toBe("final");
    expect(step2.latestVersion).toBe(2);
  });

  it("keeps step 5 (技术设计) final once tech-design v1 exists, without requiring a review round", () => {
    const steps = deriveStudioSteps(
      baseInput({ artifacts: { "tech-design": { latestVersion: 1 } } }),
    );
    expect(steps.find((s) => s.step === 5)!.state).toBe("final");
    // Step 6 (对抗评审) shares the tech-design docKey but needs v2+.
    expect(steps.find((s) => s.step === 6)!.state).not.toBe("final");
  });

  it("marks step 6 (对抗评审) final once tech-design has been revised to v2+", () => {
    const steps = deriveStudioSteps(
      baseInput({ artifacts: { "tech-design": { latestVersion: 2 } } }),
    );
    expect(steps.find((s) => s.step === 6)!.state).toBe("final");
  });

  it("passes producedByKind through to the derived step (rail's `docKey vN · agent|human` subtext)", () => {
    const steps = deriveStudioSteps(
      baseInput({
        artifacts: {
          "sprint-doc": { latestVersion: 2, producedByKind: "human" },
          "test-plan": { latestVersion: 1, producedByKind: "agent" },
        },
      }),
    );
    expect(steps.find((s) => s.step === 2)!.producedByKind).toBe("human");
    expect(steps.find((s) => s.step === 3)!.producedByKind).toBe("agent");
    // Facts without producedByKind pass through as null (rail hides the suffix).
    expect(steps.find((s) => s.step === 5)!.producedByKind).toBeNull();
  });
});

describe("deriveStudioSteps — 进行中 (in-progress)", () => {
  it("marks the active-session step in-progress when it has no artifact version yet", () => {
    const steps = deriveStudioSteps(baseInput({ activeStep: 3 }));
    const step3 = steps.find((s) => s.step === 3)!;
    expect(step3.state).toBe("in-progress");
  });

  it("prefers final over in-progress when a version already exists", () => {
    const steps = deriveStudioSteps(
      baseInput({
        activeStep: 3,
        artifacts: { "test-plan": { latestVersion: 1 } },
      }),
    );
    expect(steps.find((s) => s.step === 3)!.state).toBe("final");
  });
});

describe("deriveStudioSteps — ①跳过 (skipped)", () => {
  it("marks step 1 skipped when sprint-doc exists but brainstorm-notes never has a version", () => {
    const steps = deriveStudioSteps(
      baseInput({ artifacts: { "sprint-doc": { latestVersion: 1 } } }),
    );
    expect(steps.find((s) => s.step === 1)!.state).toBe("skipped");
  });

  it("does not mark step 1 skipped before sprint-doc exists", () => {
    const steps = deriveStudioSteps(baseInput());
    expect(steps.find((s) => s.step === 1)!.state).toBe("pending");
  });

  it("marks step 1 final when brainstorm-notes has a version, even if sprint-doc also exists", () => {
    const steps = deriveStudioSteps(
      baseInput({
        artifacts: {
          "brainstorm-notes": { latestVersion: 1 },
          "sprint-doc": { latestVersion: 1 },
        },
      }),
    );
    expect(steps.find((s) => s.step === 1)!.state).toBe("final");
  });
});

describe("deriveStudioSteps — ④不适用 (not-applicable)", () => {
  it("marks step 4 not-applicable when sprint-doc's In-Scope has no UI-shaped outcome", () => {
    const steps = deriveStudioSteps(
      baseInput({
        artifacts: { "sprint-doc": { latestVersion: 1 } },
        inScopeOutcomes: [
          { id: "O1", statement: "后台批处理任务每日零点执行结算" },
          { id: "O2", statement: "生成对账报表写入数据仓库" },
        ],
      }),
    );
    expect(steps.find((s) => s.step === 4)!.state).toBe("not-applicable");
  });

  it("does not mark step 4 not-applicable when an outcome reads as UI-shaped", () => {
    const steps = deriveStudioSteps(
      baseInput({
        artifacts: { "sprint-doc": { latestVersion: 1 } },
        inScopeOutcomes: [
          { id: "O1", statement: "商户在账单页面点击导出按钮下载 CSV" },
        ],
      }),
    );
    expect(steps.find((s) => s.step === 4)!.state).not.toBe("not-applicable");
  });

  it("does not mark step 4 not-applicable once a real ui-spec version exists (real work trumps the guess)", () => {
    const steps = deriveStudioSteps(
      baseInput({
        artifacts: {
          "sprint-doc": { latestVersion: 1 },
          "ui-spec": { latestVersion: 1 },
        },
        inScopeOutcomes: [
          { id: "O1", statement: "后台批处理任务每日零点执行结算" },
        ],
      }),
    );
    expect(steps.find((s) => s.step === 4)!.state).toBe("final");
  });

  it("leaves step 4 pending (unknown) when sprint-doc has no In-Scope outcomes yet", () => {
    const steps = deriveStudioSteps(baseInput());
    expect(steps.find((s) => s.step === 4)!.state).toBe("pending");
  });
});

describe("deriveStudioSteps — manual override", () => {
  it("lets a manual override win over every derived rule", () => {
    const steps = deriveStudioSteps(
      baseInput({
        artifacts: { "sprint-doc": { latestVersion: 3 } },
        stepOverrides: { 2: "skipped" },
      }),
    );
    expect(steps.find((s) => s.step === 2)!.state).toBe("skipped");
  });
});

describe("hasUiShapedInScope", () => {
  it("returns null when there are no outcomes to judge", () => {
    expect(hasUiShapedInScope([])).toBeNull();
  });

  it("returns false when no outcome mentions UI-shaped language", () => {
    expect(
      hasUiShapedInScope([{ id: "O1", statement: "纯后端定时任务" }]),
    ).toBe(false);
  });

  it("returns true when any outcome mentions UI-shaped language", () => {
    expect(
      hasUiShapedInScope([
        { id: "O1", statement: "纯后端定时任务" },
        { id: "O2", statement: "新增一个设置弹窗" },
      ]),
    ).toBe(true);
  });
});
