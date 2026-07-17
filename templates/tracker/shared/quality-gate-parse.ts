/**
 * R4b.2 Sprint Studio — quality-gate bar dual-track merge
 * (r4-workflow-families-planning-skills.md §5.2 "质量门双轨" / §5.4 "质量门条").
 *
 * Track 1 (machine): `check-artifact-gates` action → `ChecklistItem[]`,
 * deterministic, never overridable. Track 2 (self): the artifact's own
 * markdown tail section written by the authoring skill:
 *
 *   ## 质量门自评
 *   - goal-metrics-falsifiable | pass | M1/M2 均带 Leading/Lagging 与可证伪信号
 *
 * (exact format from `.agents/skills/sprint-plan/SKILL.md`'s worked example —
 * every planning skill appends the same shape). Self items are overridable by
 * the signoff approver; an override is recorded through the existing
 * `set-artifact-review` mechanism using the reviewKey namespace
 * `gate-override:{key}` anchored to the same artifactId+version — reusing
 * `tracker_artifact_reviews` (already checked/reset-on-new-version) instead of
 * inventing a new persistence layer, and picking up the framework's automatic
 * action-seam audit trail for free (no bespoke "who overrode what" table).
 */

/**
 * Shape of `check-artifact-gates`'s returned items — deliberately a LOCAL
 * type, not a shared `ChecklistItem` import: `shared/types.ts` already has
 * its own distinct `ChecklistItem` (with a required `checked: boolean`, for
 * `get-review-checklist`'s persisted-tick rendering) and
 * `server/lib/review-checklist.ts` has a third, server-only one (no
 * `checked`, DB-backed) — both coincidentally share the name for an
 * unrelated shape. This one matches exactly what `assembleArtifactGates`
 * (server/lib/artifact-gates.ts) actually returns: `{key,label,source,state,detail?}`,
 * no `checked` field.
 */
export interface MachineGateItem {
  key: string;
  label: string;
  source: "machine" | "human";
  state: "pass" | "fail" | "needs-human";
  detail?: string;
}

export interface SelfAssessmentItem {
  key: string;
  verdict: "pass" | "fail";
  evidence: string;
}

const SELF_ASSESSMENT_HEADING_RE = /^##\s+质量门自评\s*$/;
const HEADING_RE = /^#{1,6}\s/;
const SELF_ITEM_RE = /^[-*]\s*([\w.:-]+)\s*\|\s*(pass|fail)\s*\|\s*(.*)$/i;

/** Parse the `## 质量门自评` section's `- key | pass|fail | evidence` bullets. */
export function parseSelfAssessment(content: string): SelfAssessmentItem[] {
  const lines = content.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (SELF_ASSESSMENT_HEADING_RE.test(lines[i]!.trim())) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return [];

  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (HEADING_RE.test(lines[i]!.trim())) {
      end = i;
      break;
    }
  }

  const items: SelfAssessmentItem[] = [];
  for (const raw of lines.slice(start, end)) {
    const m = SELF_ITEM_RE.exec(raw.trim());
    if (!m) continue;
    items.push({
      key: m[1]!,
      verdict: m[2]!.toLowerCase() as "pass" | "fail",
      evidence: m[3]!.trim(),
    });
  }
  return items;
}

export type QualityGateTrack = "machine" | "self";

export interface MergedQualityGateItem {
  key: string;
  label: string;
  track: QualityGateTrack;
  /** Effective, post-override verdict. */
  verdict: "pass" | "fail";
  /** The self-assessed verdict before any override (machine items: same as verdict). */
  rawVerdict: "pass" | "fail" | "needs-human";
  detail?: string;
  /** True when a signoff approver overrode a failing self-assessment item to pass. */
  overridden: boolean;
  /** Machine items can never be overridden by a human. */
  overridable: boolean;
}

/** `gate-override:{key}` review rows (from `list-artifact-reviews`) that are
 *  currently checked — the override signal for self-assessment items. */
export interface GateOverrideSignal {
  key: string;
  checked: boolean;
}

/**
 * Merge the machine (`check-artifact-gates`) and self (`## 质量门自评`) tracks
 * into one ordered list for the quality-gate bar. Machine items always keep
 * their computed verdict (non-overridable); self items apply any matching
 * `gate-override:{key}` signal on top of the authored verdict.
 */
export function mergeQualityGate(
  machineItems: MachineGateItem[],
  selfItems: SelfAssessmentItem[],
  overrides: GateOverrideSignal[] = [],
): MergedQualityGateItem[] {
  const overrideByKey = new Map(overrides.map((o) => [o.key, o.checked]));

  const machine: MergedQualityGateItem[] = machineItems.map((i) => ({
    key: i.key,
    label: i.label,
    track: "machine",
    verdict: i.state === "pass" ? "pass" : "fail",
    rawVerdict: i.state,
    detail: i.detail,
    overridden: false,
    overridable: false,
  }));

  const self: MergedQualityGateItem[] = selfItems.map((i) => {
    const overridden =
      i.verdict === "fail" && overrideByKey.get(i.key) === true;
    return {
      key: i.key,
      label: i.key,
      track: "self",
      verdict: overridden ? "pass" : i.verdict,
      rawVerdict: i.verdict,
      detail: i.evidence,
      overridden,
      overridable: true,
    };
  });

  return [...machine, ...self];
}

/** Gate the "采纳为 <docKey> vN" button on the machine track only — self
 *  items are informative/overridable and never block adoption (§5.4). */
export function machineTrackAllPass(merged: MergedQualityGateItem[]): boolean {
  return merged
    .filter((i) => i.track === "machine")
    .every((i) => i.verdict === "pass");
}

/** Reusable `reviewKey` builder for a self-assessment override — anchors to
 *  the same (artifactId, version) as the three-question review checkboxes,
 *  in a distinct `gate-override:` namespace so the two never collide. */
export function gateOverrideReviewKey(key: string): string {
  return `gate-override:${key}`;
}
