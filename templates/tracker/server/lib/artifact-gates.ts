/**
 * R4b.1 `check-artifact-gates` — deterministic, docKey-parameterized quality
 * gate for sprint artifacts (dual-track quality gate's machine half, per
 * docs/sdlc-product-design/r4-workflow-families-planning-skills.md §5.2).
 *
 * Directly copies the shape of `server/lib/review-checklist.ts` +
 * `actions/get-review-checklist.ts` (F6's existing review-checklist
 * mechanism) per the design doc's explicit instruction: `ChecklistItem[]`
 * assembled by a discriminator (there: work-item `nature`; here: `docKey`),
 * machine-sourced items are deterministic/non-overridable, human-sourced
 * items require manual confirmation elsewhere (`set-artifact-review`) and are
 * never computed here. Reuses `ChecklistItem`/`ChecklistItemSource`/
 * `ChecklistItemState` from review-checklist.ts rather than redefining them.
 *
 * Also reuses `extract-goal-metrics.ts`'s `parseSuccessMetrics` directly for
 * the sprint-doc M-number check — the second cited precedent ("从文本产物里
 * 确定性解析出判据") — instead of re-parsing Success Metrics from scratch.
 *
 * Per-docKey rule sets implement exactly §5.2's table. docKeys the table
 * doesn't specify a rule set for (`brief:{itemKey}`, `shared-brief`,
 * `briefs-index`, `story`, `verify-report`, `audit-report:{n}`) get a single
 * placeholder non-empty-content check — see the TODO below rather than
 * inventing unstated rules.
 */

import { parseSuccessMetrics } from "../../actions/extract-goal-metrics.js";
import type { ChecklistItem, ChecklistItemState } from "./review-checklist.js";
import {
  parseInScopeOutcomes,
  parseOutOfScope,
  findDocHygieneViolations,
} from "./sprint-doc-parse.js";
import {
  parseTechDesignItems,
  parseFileMatrix,
  extractSection,
} from "./tech-design-parse.js";
import {
  parseScenarios,
  hasInternalSymbolLeak,
  parseNoIntegrationDeclaration,
} from "./test-plan-parse.js";
import {
  parseUiSpecScreens,
  parseScreenList,
  parseNoUiOutcomes,
} from "./ui-spec-parse.js";

export type { ChecklistItem } from "./review-checklist.js";

export interface ArtifactGateContext {
  /** Latest sprint-doc content — required to check ui-spec's outcome mapping. */
  sprintDocContent?: string;
  /** Latest ui-spec content — required to check tech-design's screen refs. */
  uiSpecContent?: string;
  /** Count of work items belonging to the sprint — required for tech-design's §4 count check. */
  sprintWorkItemCount?: number;
}

function machineItem(
  key: string,
  label: string,
  state: ChecklistItemState,
  detail?: string,
): ChecklistItem {
  return { key, label, source: "machine", state, detail };
}

function humanItem(key: string, label: string): ChecklistItem {
  return { key, label, source: "human", state: "needs-human" };
}

// ---------------------------------------------------------------------------
// sprint-doc
// ---------------------------------------------------------------------------

function assembleSprintDocGates(content: string): ChecklistItem[] {
  const { metrics, warnings } = parseSuccessMetrics(content);
  const metricsOk = metrics.length > 0;
  const items: ChecklistItem[] = [
    machineItem(
      "goal-metrics-falsifiable",
      "Goal 指标带稳定 M 编号且 Leading/Lagging 可证伪",
      metricsOk ? "pass" : "fail",
      metricsOk
        ? undefined
        : (warnings[0] ?? "Success Metrics 节未找到或无 M 编号条目"),
    ),
  ];

  const outOfScope = parseOutOfScope(content);
  items.push(
    machineItem(
      "out-of-scope-non-empty",
      "Out-of-Scope 非空",
      outOfScope.length > 0 ? "pass" : "fail",
      outOfScope.length > 0 ? undefined : "未找到 Out-of-Scope 小节或小节为空",
    ),
  );

  const violations = findDocHygieneViolations(content);
  items.push(
    machineItem(
      "no-file-paths-or-code",
      "全文无文件路径/代码块",
      violations.length === 0 ? "pass" : "fail",
      violations.length === 0
        ? undefined
        : violations
            .slice(0, 5)
            .map((v) => `${v.kind}:${v.snippet}`)
            .join("; "),
    ),
  );

  items.push(
    humanItem(
      "p0-delete-test",
      "P0 项通过删除测试（删掉后 Goal 是否塌 —— 需人工判断）",
    ),
  );

  return items;
}

// ---------------------------------------------------------------------------
// test-plan
// ---------------------------------------------------------------------------

function assembleTestPlanGates(content: string): ChecklistItem[] {
  const scenarios = parseScenarios(content);
  const noIntegrationNote = parseNoIntegrationDeclaration(content);

  if (scenarios.length === 0 && noIntegrationNote) {
    return [
      machineItem(
        "scenario-falsifiable-signal",
        "每场景有可证伪信号",
        "pass",
        `已声明无跨模块场景：${noIntegrationNote.slice(0, 80)}`,
      ),
      machineItem("black-box-language", "黑盒（无内部符号名）", "pass"),
      machineItem("metrics-linked", "覆盖矩阵由关联指标字段确定性生成", "pass"),
    ];
  }

  const missingSignal = scenarios.filter(
    (s) => !s.fields["Pass-fail 信号"]?.trim(),
  );
  const withLeak = scenarios.filter(hasInternalSymbolLeak);
  const missingMetric = scenarios.filter(
    (s) =>
      s.metricRefs.length === 0 || s.metricRefs.some((m) => !/^M\d+$/.test(m)),
  );

  return [
    machineItem(
      "scenario-falsifiable-signal",
      "每场景有可证伪信号",
      scenarios.length > 0 && missingSignal.length === 0 ? "pass" : "fail",
      scenarios.length === 0
        ? "未找到任何场景卡（## 场景），也未声明无集成场景"
        : missingSignal.length > 0
          ? `缺 Pass-fail 信号: ${missingSignal.map((s) => s.id).join(", ")}`
          : undefined,
    ),
    machineItem(
      "black-box-language",
      "黑盒（无内部符号名，启发式检测代码片段泄漏，可能漏报）",
      withLeak.length === 0 ? "pass" : "fail",
      withLeak.length === 0
        ? undefined
        : `疑似泄漏内部符号: ${withLeak.map((s) => s.id).join(", ")}`,
    ),
    machineItem(
      "metrics-linked",
      "覆盖矩阵由「关联指标」字段确定性生成（每场景须关联≥1个合法 M 编号）",
      missingMetric.length === 0 && scenarios.length > 0 ? "pass" : "fail",
      missingMetric.length > 0
        ? `缺/非法关联指标: ${missingMetric.map((s) => s.id).join(", ")}`
        : undefined,
    ),
  ];
}

// ---------------------------------------------------------------------------
// ui-spec
// ---------------------------------------------------------------------------

function assembleUiSpecGates(
  content: string,
  sprintDocContent?: string,
): ChecklistItem[] {
  const items: ChecklistItem[] = [];

  if (sprintDocContent == null) {
    items.push(
      humanItem(
        "outcomes-mapped-to-screens",
        "每条 In-Scope outcome 映射到至少一屏或显式无界面（未提供 sprint-doc，需人工核对）",
      ),
    );
  } else {
    const inScope = parseInScopeOutcomes(sprintDocContent);
    const screens = parseUiSpecScreens(content);
    const noUi = new Set(parseNoUiOutcomes(content));
    const mapped = new Set<string>(noUi);
    for (const s of screens) for (const o of s.outcomeRefs) mapped.add(o);
    const missing = inScope.filter((o) => !mapped.has(o.id));
    items.push(
      machineItem(
        "outcomes-mapped-to-screens",
        "每条 In-Scope outcome 映射到至少一屏或显式无界面",
        missing.length === 0 ? "pass" : "fail",
        missing.length === 0
          ? undefined
          : `未映射: ${missing.map((o) => o.id).join(", ")}`,
      ),
    );
  }

  const screenIds = parseScreenList(content);
  const expectedIds = screenIds.map((_, i) => `S${i + 1}`);
  const stable =
    screenIds.length > 0 &&
    new Set(screenIds).size === screenIds.length &&
    screenIds.every((id, i) => id === expectedIds[i]);
  items.push(
    machineItem(
      "screen-ids-stable",
      "屏编号稳定可被 tech-design 引用（S1..Sn 连续且无重复）",
      screenIds.length === 0 ? "fail" : stable ? "pass" : "fail",
      screenIds.length === 0
        ? "未找到屏清单（## 屏清单）"
        : stable
          ? undefined
          : `屏编号不连续或有重复: ${screenIds.join(", ")}`,
    ),
  );

  return items;
}

// ---------------------------------------------------------------------------
// tech-design
// ---------------------------------------------------------------------------

const PATH_TOKEN_RE = /`([\w.-]+(?:\/[\w.-]+)+\.\w+)`/g;

function assembleTechDesignGates(
  content: string,
  uiSpecContent?: string,
  sprintWorkItemCount?: number,
): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const techItems = parseTechDesignItems(content);

  if (sprintWorkItemCount == null) {
    items.push(
      humanItem(
        "section-count-matches-items",
        "§4 节数=sprint 开发项数（未提供工作项计数，需人工核对）",
      ),
    );
  } else {
    const ok = techItems.length === sprintWorkItemCount;
    items.push(
      machineItem(
        "section-count-matches-items",
        "§4 节数=sprint 开发项数",
        ok ? "pass" : "fail",
        ok
          ? undefined
          : `§4 含 ${techItems.length} 节，sprint 有 ${sprintWorkItemCount} 个工作项`,
      ),
    );
  }

  const fileMatrixSection = extractSection(content, 7);
  const fileRows = parseFileMatrix(content);
  const validOps = new Set(["CREATE", "MODIFY", "DELETE"]);
  const badRows = fileRows.filter((r) => !validOps.has(r.operation));
  items.push(
    machineItem(
      "file-matrix-parseable",
      "§7 五列文件矩阵机器可解析",
      fileMatrixSection != null && fileRows.length > 0 && badRows.length === 0
        ? "pass"
        : "fail",
      fileMatrixSection == null
        ? "§7 文件变更矩阵缺失"
        : fileRows.length === 0
          ? "§7 表格为空或无法解析"
          : badRows.length > 0
            ? `操作列非法: ${badRows.map((r) => r.path).join(", ")}`
            : undefined,
    ),
  );

  const referencedScreens = new Set<string>();
  for (const m of content.matchAll(/\bS\d+\b/g)) referencedScreens.add(m[0]);
  if (referencedScreens.size === 0) {
    items.push(
      machineItem(
        "ui-spec-screen-refs-exist",
        "引用的 ui-spec 屏编号存在",
        "pass",
      ),
    );
  } else if (uiSpecContent == null) {
    items.push(
      machineItem(
        "ui-spec-screen-refs-exist",
        "引用的 ui-spec 屏编号存在",
        "fail",
        `引用了屏编号 (${[...referencedScreens].join(", ")}) 但未找到 ui-spec 产物`,
      ),
    );
  } else {
    const screenIds = new Set(parseScreenList(uiSpecContent));
    const missing = [...referencedScreens].filter((id) => !screenIds.has(id));
    items.push(
      machineItem(
        "ui-spec-screen-refs-exist",
        "引用的 ui-spec 屏编号存在",
        missing.length === 0 ? "pass" : "fail",
        missing.length === 0
          ? undefined
          : `ui-spec 中不存在: ${missing.join(", ")}`,
      ),
    );
  }

  // Honest degradation (§5.2): tracker has no project checkout, so real
  // filesystem existence can't be checked — only text consistency between
  // §4's prose-mentioned paths and §7's matrix paths.
  const matrixPaths = new Set(fileRows.map((r) => r.path));
  const mentionedInBody = new Set<string>();
  for (const item of techItems) {
    for (const m of item.body.matchAll(PATH_TOKEN_RE))
      mentionedInBody.add(m[1]!);
  }
  const inconsistent = [...mentionedInBody].filter((p) => !matrixPaths.has(p));
  items.push(
    machineItem(
      "file-path-format-consistency",
      "文件路径文本一致性（§4 提及的路径均出现在 §7 矩阵中；不核验磁盘真实存在性）",
      inconsistent.length === 0 ? "pass" : "fail",
      inconsistent.length === 0
        ? undefined
        : `§4 提及但 §7 未列: ${inconsistent.join(", ")}`,
    ),
  );

  return items;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Assemble the deterministic gate checklist for one sprint artifact version.
 * Pure — no DB. `docKey` selects the rule set; unlisted docKeys fall back to
 * a single placeholder check (see module docblock).
 */
export function assembleArtifactGates(
  docKey: string,
  content: string,
  context: ArtifactGateContext = {},
): ChecklistItem[] {
  if (docKey === "brainstorm-notes") {
    // §5.2: "无硬门（可选步）" — brainstorm is optional and has no hard gate.
    return [];
  }
  if (docKey === "sprint-doc") return assembleSprintDocGates(content);
  if (docKey === "test-plan") return assembleTestPlanGates(content);
  if (docKey === "ui-spec")
    return assembleUiSpecGates(content, context.sprintDocContent);
  if (docKey === "tech-design") {
    return assembleTechDesignGates(
      content,
      context.uiSpecContent,
      context.sprintWorkItemCount,
    );
  }

  // TODO(§5.2 未覆盖的 docKey): the design doc's rule table only specifies
  // sprint-doc / test-plan / ui-spec / tech-design. `brief:{itemKey}` /
  // `shared-brief` / `briefs-index` / `story` / `verify-report` /
  // `audit-report:{n}` have no specified rule set yet — per this task's
  // instructions, implementing only a placeholder non-empty check here
  // rather than inventing unstated rules. Revisit once a design pass covers
  // these docKeys explicitly.
  return [
    machineItem(
      "content-non-empty",
      `产物内容非空（占位规则 — docKey "${docKey}" 尚无 §5.2 专属规则集）`,
      content.trim().length > 0 ? "pass" : "fail",
    ),
  ];
}

/** True when every assembled item is machine-pass or... — mirrors
 *  review-checklist.ts's `complete` semantics but is computed purely from
 *  the assembled list (no persistence layer here): human items are never
 *  "complete" until a human overrides them via `set-artifact-review`
 *  (out of scope for this pure function — see `actions/check-artifact-gates.ts`). */
export function allMachineGatesPass(items: ChecklistItem[]): boolean {
  return items
    .filter((i) => i.source === "machine")
    .every((i) => i.state === "pass");
}
