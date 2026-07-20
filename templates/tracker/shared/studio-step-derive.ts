/**
 * R4b.2 Sprint Studio — step-rail state derivation
 * (docs/sdlc-product-design/r4-workflow-families-planning-skills.md §5.1).
 *
 * Pure, DB-free: callers (the `view-screen` action and the Studio page's own
 * data-loading code) fetch the raw facts (latest artifact version per docKey,
 * whether a session is active on a step, the sprint-doc's In-Scope text, and
 * any manual override) and pass them in here. No new state table — every
 * derived state comes from data that already exists, per §5.1's explicit
 * "步态不建新状态表" instruction. The single genuinely-new column
 * (`sprints.studioState`) only carries the manual override half of the input.
 *
 * Precedence (highest wins):
 *   1. Manual override (`stepOverrides[step]`) — always wins when present.
 *   2. Step ① only: "skipped" when sprint-doc exists but brainstorm-notes
 *      never has a version.
 *   3. Step ④ only: "not-applicable" when the sprint-doc heuristic finds no
 *      UI-shaped In-Scope outcome AND ui-spec has never been drafted (once a
 *      real ui-spec version exists, the heuristic is moot — real work
 *      trumps the guess).
 *   4. "final" — the step's docKey has at least one artifact version. Steps
 *      ⑤ 技术设计 / ⑥ 对抗评审 share one docKey (`tech-design` — review's
 *      output is the next tech-design version, not a separate docKey per
 *      §5.2's table), so they're disambiguated by version count: ⑤ is final
 *      once v1 exists, ⑥ needs v2+ (at least one review round actually
 *      produced a revision). This is an honest heuristic, not a parsed
 *      review-round count — it can't tell "3 rounds, 0 changes" from
 *      "1 round, 2 changes"; both would read differently only if the
 *      version count differs.
 *   5. "in-progress" — a live session is active on this step
 *      (`application_state`'s `activeStep`, written on Studio page entry).
 *      There is no separate "draft" storage in this schema (only versioned
 *      artifacts), so "un-adopted draft exists" collapses to the same
 *      session-liveness signal, not a distinct persisted draft row.
 *   6. "pending" — nothing above matched; step hasn't been started.
 */

export type StudioStepState =
  | "final"
  | "in-progress"
  | "skipped"
  | "not-applicable"
  | "pending";

export type StudioStepKey =
  | "brainstorm"
  | "sprint-plan"
  | "test-plan"
  | "ui-spec"
  | "tech-design"
  | "review"
  | "briefs";

export interface StudioStepDef {
  step: number;
  key: StudioStepKey;
  docKey: string;
  label: string;
  optional?: boolean;
  conditional?: boolean;
}

export const STUDIO_STEPS: StudioStepDef[] = [
  {
    step: 1,
    key: "brainstorm",
    docKey: "brainstorm-notes",
    label: "头脑风暴",
    optional: true,
  },
  { step: 2, key: "sprint-plan", docKey: "sprint-doc", label: "Sprint 规划" },
  { step: 3, key: "test-plan", docKey: "test-plan", label: "测试计划" },
  {
    step: 4,
    key: "ui-spec",
    docKey: "ui-spec",
    label: "UI 设计",
    conditional: true,
  },
  { step: 5, key: "tech-design", docKey: "tech-design", label: "技术设计" },
  { step: 6, key: "review", docKey: "tech-design", label: "对抗评审" },
  { step: 7, key: "briefs", docKey: "briefs-index", label: "Briefs" },
];

/** Heuristic word list for step ④ applicability — same "启发式，可能漏报" honesty
 *  as the codebase's other keyword-based checks (e.g. §4.2's workspace-贯穿
 *  check, `hasInternalSymbolLeak`). Sprint-doc's `In-Scope` outcomes carry no
 *  formal tag field (`InScopeOutcome` is just `{id, statement}`); this scans
 *  outcome statement text for UI-shaped language. */
const UI_SCOPE_KEYWORDS =
  /(UI|界面|页面|屏|screen|dashboard|表单|按钮|前端|弹窗|组件|下拉|导航栏|侧栏)/i;

export interface InScopeLike {
  id: string;
  statement: string;
}

/** True when at least one In-Scope outcome reads as UI-shaped. Returns null
 *  (unknown) when there are no In-Scope outcomes to judge yet — callers
 *  should treat null as "don't mark not-applicable, sprint-doc isn't
 *  written/parseable yet." */
export function hasUiShapedInScope(outcomes: InScopeLike[]): boolean | null {
  if (outcomes.length === 0) return null;
  return outcomes.some((o) => UI_SCOPE_KEYWORDS.test(o.statement));
}

export interface StepArtifactFacts {
  /** Latest version number for this docKey, or null when no version exists yet. */
  latestVersion: number | null;
  /** Producer of the latest version (`SprintArtifact.producedByKind`), or null
   *  when no version exists / the source didn't carry the field. */
  producedByKind?: "agent" | "human" | null;
}

export interface DeriveStudioStepsInput {
  /** Latest-version facts per docKey (brainstorm-notes/sprint-doc/test-plan/ui-spec/tech-design/briefs-index). */
  artifacts: Partial<Record<string, StepArtifactFacts>>;
  /** The step number (1-7) a live session is currently on, or null/undefined if none. */
  activeStep?: number | null;
  /** Sprint-doc's In-Scope outcomes, already parsed — used only for step ④'s heuristic. */
  inScopeOutcomes?: InScopeLike[];
  /** Manual overrides from `sprints.studioState.stepOverrides`. */
  stepOverrides?: Partial<Record<number, StudioStepState>>;
}

export interface DerivedStudioStep extends StudioStepDef {
  state: StudioStepState;
  latestVersion: number | null;
  /** Producer of the latest version, passed through from the artifact facts
   *  (null when absent) — surfaced in the rail's `docKey vN · agent|human`
   *  subtext. */
  producedByKind?: "agent" | "human" | null;
  /** Short machine-readable reason, surfaced in tests and the rail's tooltip. */
  reason: string;
}

function versionOf(
  artifacts: DeriveStudioStepsInput["artifacts"],
  docKey: string,
): number | null {
  return artifacts[docKey]?.latestVersion ?? null;
}

function producedByKindOf(
  artifacts: DeriveStudioStepsInput["artifacts"],
  docKey: string,
): "agent" | "human" | null {
  return artifacts[docKey]?.producedByKind ?? null;
}

export function deriveStudioSteps(
  input: DeriveStudioStepsInput,
): DerivedStudioStep[] {
  const overrides = input.stepOverrides ?? {};
  const activeStep = input.activeStep ?? null;

  const brainstormVersion = versionOf(input.artifacts, "brainstorm-notes");
  const sprintDocVersion = versionOf(input.artifacts, "sprint-doc");
  const uiSpecVersion = versionOf(input.artifacts, "ui-spec");
  const techDesignVersion = versionOf(input.artifacts, "tech-design");

  return STUDIO_STEPS.map((def): DerivedStudioStep => {
    const override = overrides[def.step];
    if (override) {
      return {
        ...def,
        state: override,
        latestVersion: versionOf(input.artifacts, def.docKey),
        producedByKind: producedByKindOf(input.artifacts, def.docKey),
        reason: `手动覆盖为「${override}」`,
      };
    }

    if (def.step === 1) {
      if (brainstormVersion != null) {
        return {
          ...def,
          state: "final",
          latestVersion: brainstormVersion,
          producedByKind: producedByKindOf(input.artifacts, "brainstorm-notes"),
          reason: "brainstorm-notes 已有产物版本",
        };
      }
      if (sprintDocVersion != null) {
        return {
          ...def,
          state: "skipped",
          latestVersion: null,
          reason: "sprint-doc 已存在但 brainstorm-notes 从未写过，判定为跳过",
        };
      }
      if (activeStep === 1) {
        return {
          ...def,
          state: "in-progress",
          latestVersion: null,
          reason: "当前会话在此步",
        };
      }
      return {
        ...def,
        state: "pending",
        latestVersion: null,
        reason: "尚未开始",
      };
    }

    if (def.step === 4) {
      if (uiSpecVersion == null) {
        const uiShaped = hasUiShapedInScope(input.inScopeOutcomes ?? []);
        if (uiShaped === false) {
          return {
            ...def,
            state: "not-applicable",
            latestVersion: null,
            reason: "sprint-doc In-Scope 未见 UI 相关措辞（启发式，可能漏报）",
          };
        }
      }
    }

    if (def.step === 5) {
      if (techDesignVersion != null && techDesignVersion >= 1) {
        return {
          ...def,
          state: "final",
          latestVersion: techDesignVersion,
          producedByKind: producedByKindOf(input.artifacts, "tech-design"),
          reason: "tech-design 已有产物版本",
        };
      }
    } else if (def.step === 6) {
      if (techDesignVersion != null && techDesignVersion >= 2) {
        return {
          ...def,
          state: "final",
          latestVersion: techDesignVersion,
          producedByKind: producedByKindOf(input.artifacts, "tech-design"),
          reason:
            "tech-design 版本 ≥2，判定为至少完成一轮对抗评审（启发式，非精确轮次统计）",
        };
      }
    } else {
      const version = versionOf(input.artifacts, def.docKey);
      if (version != null) {
        return {
          ...def,
          state: "final",
          latestVersion: version,
          producedByKind: producedByKindOf(input.artifacts, def.docKey),
          reason: `${def.docKey} 已有产物版本`,
        };
      }
    }

    if (activeStep === def.step) {
      return {
        ...def,
        state: "in-progress",
        latestVersion: null,
        reason: "当前会话在此步（无独立草稿存储，进行中=会话存活信号）",
      };
    }

    return {
      ...def,
      state: "pending",
      latestVersion: versionOf(input.artifacts, def.docKey),
      producedByKind: producedByKindOf(input.artifacts, def.docKey),
      reason: "尚未开始",
    };
  });
}
