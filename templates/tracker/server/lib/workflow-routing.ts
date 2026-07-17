/**
 * R4a.3 L1 — deterministic pre-selection routing (design authority:
 * docs/sdlc-product-design/r4-workflow-families-planning-skills.md §4.4
 * first bullet).
 *
 * Two layers, evaluated in order:
 *   1. Project-specific rows in `tracker_project_workflow_rules` (a project
 *      can override/extend routing without a code change).
 *   2. `DEFAULT_WORKFLOW_RULES` below — the code-level fallback mirroring the
 *      s8 prototype's static routing table (需求/任务(sprint 内)→
 *      sdlc-issue-pipeline; 缺陷/生产问题→hotfix; from-audit→hotfix 形;
 *      文档→docs-task; 调研→spike-research; 无 sprint→quick-task), plus a
 *      universal quick-task catch-all so resolution never comes back empty.
 *
 * `dispatch-to-orchestrator.ts` calls `resolveWorkflowRule` and forwards the
 * result as structured `{suggestedTemplate, ruleId}` tags (+ `suggestedInputs`)
 * on the brain-send call — a deterministic pre-selection, not a mandate: the
 * brain remains free to deviate (see the L2 deviation-tracking piece).
 */

import { and, eq } from "drizzle-orm";

import { getDb, schema } from "../db/index.js";
import { ownerScope } from "./access.js";

export interface WorkflowRuleSpec {
  /** Matches work_items.type. "" = any (wildcard). */
  itemType: string;
  /** Matches itemType OR any tag/nature entry. "" = any (wildcard). */
  nature: string;
  /** null = any; true = item must be in a sprint; false = item must not be. */
  inSprint: boolean | null;
  templateName: string;
  defaultInputs: Record<string, unknown>;
  /** Lower = evaluated first (matches this repo's existing priority convention). */
  priority: number;
}

export interface WorkflowRuleMatchContext {
  itemType: string;
  /** itemType + tags + nature tags — every string the rule's `nature`
   *  matcher may compare against. */
  natureCandidates: string[];
  inSprint: boolean;
}

export interface ResolvedWorkflowRule {
  ruleId: string;
  templateName: string;
  defaultInputs: Record<string, unknown>;
  source: "project" | "default";
}

/**
 * Code-level fallback routing table — applied only when a project has no
 * matching row of its own. Priority ascending (first match wins); the final
 * entry is a universal catch-all so resolution always returns a suggestion.
 */
export const DEFAULT_WORKFLOW_RULES: WorkflowRuleSpec[] = [
  {
    itemType: "from-audit",
    nature: "",
    inSprint: null,
    templateName: "hotfix",
    defaultInputs: {},
    priority: 10,
  },
  {
    itemType: "",
    nature: "文档",
    inSprint: null,
    templateName: "docs-task",
    defaultInputs: {},
    priority: 20,
  },
  {
    itemType: "",
    nature: "调研",
    inSprint: null,
    templateName: "spike-research",
    defaultInputs: {},
    priority: 20,
  },
  {
    itemType: "缺陷",
    nature: "",
    inSprint: null,
    templateName: "hotfix",
    defaultInputs: {},
    priority: 30,
  },
  {
    itemType: "生产问题",
    nature: "",
    inSprint: null,
    templateName: "hotfix",
    defaultInputs: {},
    priority: 30,
  },
  {
    itemType: "需求",
    nature: "",
    inSprint: true,
    templateName: "sdlc-issue-pipeline",
    defaultInputs: {},
    priority: 40,
  },
  {
    itemType: "任务",
    nature: "",
    inSprint: true,
    templateName: "sdlc-issue-pipeline",
    defaultInputs: {},
    priority: 40,
  },
  {
    itemType: "",
    nature: "",
    inSprint: false,
    templateName: "quick-task",
    defaultInputs: {},
    priority: 90,
  },
  // Universal catch-all (in-sprint items whose type isn't otherwise routed,
  // e.g. 集合/测试) — keeps resolveWorkflowRule total.
  {
    itemType: "",
    nature: "",
    inSprint: null,
    templateName: "quick-task",
    defaultInputs: {},
    priority: 100,
  },
];

/** Pure: does `rule` match this dispatch context? Each dimension is
 *  independently wildcard-able; all set dimensions must match. */
export function matchesWorkflowRule(
  rule: WorkflowRuleSpec,
  ctx: WorkflowRuleMatchContext,
): boolean {
  if (rule.itemType && rule.itemType !== ctx.itemType) return false;
  if (rule.nature && !ctx.natureCandidates.includes(rule.nature)) return false;
  if (rule.inSprint !== null && rule.inSprint !== ctx.inSprint) return false;
  return true;
}

/** Pure: find the first (lowest-priority-number) match in an already
 *  priority-sorted rule list. */
export function findFirstMatch(
  rules: WorkflowRuleSpec[],
  ctx: WorkflowRuleMatchContext,
): WorkflowRuleSpec | null {
  const sorted = [...rules].sort((a, b) => a.priority - b.priority);
  for (const rule of sorted) {
    if (matchesWorkflowRule(rule, ctx)) return rule;
  }
  return null;
}

function parseDefaultInputs(
  raw: string | null | undefined,
): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Resolve the L1-suggested template for a dispatch. Checks the project's own
 * `tracker_project_workflow_rules` rows first (ownerScope-guarded), then
 * falls back to `DEFAULT_WORKFLOW_RULES`. Always returns a suggestion (the
 * default table's last entry is a universal catch-all).
 */
export async function resolveWorkflowRule(
  db: ReturnType<typeof getDb>,
  args: {
    projectId: string;
    itemType: string;
    tags: string[];
    natureTags: string[];
    inSprint: boolean;
  },
): Promise<ResolvedWorkflowRule> {
  const ctx: WorkflowRuleMatchContext = {
    itemType: args.itemType,
    natureCandidates: [args.itemType, ...args.tags, ...args.natureTags].filter(
      (v): v is string => !!v,
    ),
    inSprint: args.inSprint,
  };

  const rows = await db
    .select()
    .from(schema.projectWorkflowRules)
    .where(
      and(
        eq(schema.projectWorkflowRules.projectId, args.projectId),
        ownerScope(schema.projectWorkflowRules),
      ),
    );

  const projectRules: WorkflowRuleSpec[] = rows.map((r) => ({
    itemType: r.itemType,
    nature: r.nature,
    inSprint: r.inSprint === null ? null : r.inSprint === 1,
    templateName: r.templateName,
    defaultInputs: parseDefaultInputs(r.defaultInputs),
    priority: r.priority,
  }));

  const projectMatch = findFirstMatch(projectRules, ctx);
  if (projectMatch) {
    const row = rows.find(
      (r) =>
        r.templateName === projectMatch.templateName &&
        r.priority === projectMatch.priority &&
        r.itemType === projectMatch.itemType &&
        r.nature === projectMatch.nature,
    );
    return {
      ruleId: row?.id ?? `project:${projectMatch.templateName}`,
      templateName: projectMatch.templateName,
      defaultInputs: projectMatch.defaultInputs,
      source: "project",
    };
  }

  const defaultMatch = findFirstMatch(DEFAULT_WORKFLOW_RULES, ctx);
  // DEFAULT_WORKFLOW_RULES's last entry is a wildcard-everything catch-all,
  // so this is unreachable in practice — kept as a fail-safe rather than a
  // non-null assertion.
  const chosen =
    defaultMatch ?? DEFAULT_WORKFLOW_RULES[DEFAULT_WORKFLOW_RULES.length - 1]!;
  return {
    ruleId: `default:${chosen.templateName}:${chosen.priority}`,
    templateName: chosen.templateName,
    defaultInputs: chosen.defaultInputs,
    source: "default",
  };
}
