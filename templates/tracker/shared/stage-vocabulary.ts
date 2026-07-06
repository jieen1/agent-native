// Pure helpers for Stage Configuration (M2): deriving the stage vocabulary
// order/shape from a project's stageFlows / stageDescriptions / stageGateConfig
// JSON columns. Shared by get-stage-config.ts (returns the full vocabulary to
// the Stage Configuration UI) and list-stages.ts (orders a work item's stage
// rows), so both stay in lockstep — no I/O here, only JSON parsing + pure
// derivation, mirroring shared/graph-validation.ts's shape.
//
// Backward compatibility is load-bearing: LEGACY_STAGE_ORDER is byte-for-byte
// the same 7 names in the same order as list-stages.ts's pre-M2 hardcoded
// CASE and create-work-item.ts's pre-M2 default plannedStages. A project that
// has configured zero stage flows always derives exactly this order.

import type { StageFlow } from "./types.js";

export const LEGACY_STAGE_ORDER = [
  "待办",
  "分析",
  "设计",
  "实施",
  "测试",
  "验收",
  "交付",
] as const;

/** Parse a JSON object column, tolerating malformed/missing values. */
export function safeParseObject(
  raw: string | null | undefined,
): Record<string, any> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

/** Parse the stageFlows JSON array column, tolerating malformed/missing values. */
export function safeParseFlows(raw: string | null | undefined): StageFlow[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (f): f is StageFlow =>
        f &&
        typeof f === "object" &&
        typeof f.id === "string" &&
        typeof f.name === "string",
    );
  } catch {
    return [];
  }
}

/**
 * Derive the stage vocabulary's name order: the legacy 7 defaults first (so
 * a project with no custom flows derives an identical order to today's
 * hardcoded ordering), then any additional names introduced by a flow's
 * stageNames, a stageDescriptions key, or a stageGateConfig key — in
 * first-seen order, deduplicated.
 */
export function buildStageVocabularyOrder(
  flows: StageFlow[],
  descriptions: Record<string, unknown>,
  gateConfig: Record<string, unknown>,
): string[] {
  const order: string[] = [...LEGACY_STAGE_ORDER];
  const seen = new Set<string>(order);
  const addName = (name: unknown) => {
    if (typeof name !== "string" || !name || seen.has(name)) return;
    seen.add(name);
    order.push(name);
  };
  for (const flow of flows) {
    for (const name of flow.stageNames ?? []) addName(name);
  }
  for (const name of Object.keys(descriptions)) addName(name);
  for (const name of Object.keys(gateConfig)) addName(name);
  return order;
}

/**
 * Preset gateKey tokens for the "需要审批" (requireApproval) vocabulary
 * toggle. request-approval.ts's gateKey is a closed enum
 * (plan-signoff/design-signoff/escalation/audit-deferral), so a stage name
 * that isn't one of these canonical stages can't yet have an approval row
 * created for it — it maps to "escalation" (the generic catch-all gate) so
 * the toggle is at least representable and consistent, rather than storing an
 * unusable arbitrary token.
 */
export const STAGE_APPROVAL_GATE_KEYS: Record<string, string> = {
  分析: "plan-signoff",
  设计: "design-signoff",
  验收: "audit-deferral",
};

export function approvalGateKeyFor(stageName: string): string {
  return STAGE_APPROVAL_GATE_KEYS[stageName] ?? "escalation";
}
