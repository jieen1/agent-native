// Pure logic for /board (app/pages/BoardPage.tsx) — column width rules, the
// drag gate matrix, per-stage StatusRing identity, run/queue aggregation, and
// small formatting helpers. Kept framework-free (no React) so it can be unit
// tested directly without a DOM, mirroring lib/inbox.ts.
import { STAGE_ORDER, type StageName } from "@shared/types";
import type { ActivityResponse } from "@shared/types";

import { failingNodesOf } from "@/components/RunEvidenceList";
import type { StatusRingStatus } from "@/components/StatusRing";

export { STAGE_ORDER };
export type { StageName };

// ── Column width (issue #1: slim structural columns vs. active/gate columns) ─
//
// 待办/分析/设计/交付 are sparse-by-default planning/archival columns — when
// they hold zero cards they collapse to a 150px "slim" rail instead of
// wasting board width. 实施/测试/验收 stay full width always: 实施/测试 are
// where live work concentrates, and 验收 is a gate column that must stay
// ready to show a drop-hint / ghost card even at zero items.
export const ALWAYS_FULL_WIDTH_STAGES = new Set<StageName>([
  "实施",
  "测试",
  "验收",
]);

export function isColumnSlim(stage: StageName, itemCount: number): boolean {
  return itemCount === 0 && !ALWAYS_FULL_WIDTH_STAGES.has(stage);
}

// ── Column-head StatusRing identity (issue #2) ───────────────────────────────
//
// Fixed per-stage identity (what KIND of work this column represents), not a
// function of current card counts — 设计 shows "review" even when empty
// because the stage itself is review-natured. 交付 is a terminal state and
// uses StatusIcon (tone "ok"), never StatusRing — see StatusRing.tsx's own
// "terminal states use StatusIcon instead" rule.
export const STAGE_RING_STATUS: Partial<Record<StageName, StatusRingStatus>> = {
  待办: "pending",
  分析: "pending",
  设计: "review",
  实施: "running",
  测试: "running",
  验收: "gate",
};

// ── 实施 column head aggregation (issue #3: "运行中 x · 排队 y") ─────────────

export interface RunningQueuedCounts {
  running: number;
  queued: number;
}

export function runningQueuedCounts(
  items: { status: string }[],
): RunningQueuedCounts {
  let running = 0;
  let queued = 0;
  for (const it of items) {
    if (it.status === "running" || it.status === "dispatched") running += 1;
    else if (it.status === "queued") queued += 1;
  }
  return { running, queued };
}

// ── Drag gate matrix (issue #4) ──────────────────────────────────────────────
//
// 03-tracker.md §3 "拖拽语义(有门的移动)":
//   - 实施⇄测试 is writeback/人工完成-only — never a manual board drag, either
//     direction.
//   - Every other forward move is a Sprint-phase-advance REQUEST (single card
//     has no independent forward semantics in the phase-derived ranges
//     待办~设计 / 验收~交付) — dispatched as advance-stage(scope=sprint,
//     fromStage=<the dragged card's own stage>), which no-ops any item that
//     doesn't currently sit at fromStage and blocks (without mutating) any
//     item whose gate criteria aren't met.
//   - Any backward move (outside the locked 实施⇄测试 pair) is a per-item
//     rollback (rollback-stage).
//   - A drop is only supported one column at a time — skip-drops (dropping
//     past the immediately adjacent column) aren't a single documented
//     transition, so they're rejected rather than silently guessing intent.
export const ACTIVE_STAGE_GROUP = new Set<StageName>(["实施", "测试"]);

export type BoardDropClassification =
  | { kind: "noop" }
  | { kind: "locked-active" }
  | { kind: "skip-forbidden" }
  | { kind: "sprint-advance"; fromStage: StageName }
  | { kind: "rollback"; fromStage: StageName; toStage: StageName };

export function classifyBoardDrop(
  fromStage: StageName,
  toStage: StageName,
): BoardDropClassification {
  if (fromStage === toStage) return { kind: "noop" };
  const fromIdx = STAGE_ORDER.indexOf(fromStage);
  const toIdx = STAGE_ORDER.indexOf(toStage);
  if (fromIdx === -1 || toIdx === -1) return { kind: "noop" };

  if (ACTIVE_STAGE_GROUP.has(fromStage) && ACTIVE_STAGE_GROUP.has(toStage)) {
    return { kind: "locked-active" };
  }

  const forward = toIdx > fromIdx;
  if (forward) {
    if (toIdx - fromIdx > 1) return { kind: "skip-forbidden" };
    return { kind: "sprint-advance", fromStage };
  }
  if (fromIdx - toIdx > 1) return { kind: "skip-forbidden" };
  return { kind: "rollback", fromStage, toStage };
}

// ── Actor resolution (issue #6: ActorAvatar) ─────────────────────────────────

export type BoardActorKind = "human" | "agent";

export interface BoardActor {
  kind: BoardActorKind;
  initials?: string;
}

/** Initials from an email or free-text name — "steve.jobs@x.com" -> "SJ". */
export function initialsFromOwner(owner: string): string {
  const local = owner.split("@")[0] ?? owner;
  const parts = local.split(/[.\-_\s]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function resolveCardActor(owner: string | null | undefined): BoardActor {
  if (!owner) return { kind: "human" };
  if (owner === "agent" || owner === "智能体") return { kind: "agent" };
  return { kind: "human", initials: initialsFromOwner(owner) };
}

// ── Failed-card evidence (issue #9) ──────────────────────────────────────────
//
// The ONE truthful failure line for a board card: the first real failing
// node's error text (same `failingNodesOf` predicate RunEvidenceList/
// FailedRunEvidence already established — no fabricated "errorClass"/retry
// count, see RunEvidenceList.tsx's own investigated-gap note).
export function firstFailureSummary(
  activity: ActivityResponse | undefined,
): string | null {
  const nodes = (activity?.runs ?? []).flatMap((r) => r.nodes ?? []);
  const failing = failingNodesOf(nodes);
  return failing[0]?.error ?? null;
}

// ── mini-step sequence (issue #8) ────────────────────────────────────────────
//
// plannedStages (when set and a genuine subset) replaces the full 7-stage
// sequence — 01-design-system.md §3.2: "未激活阶段直接不渲染而非置灰".
export function miniStepSequence(
  plannedStages: string[] | undefined,
): StageName[] {
  if (plannedStages && plannedStages.length > 0 && plannedStages.length < 7) {
    return plannedStages.filter((s): s is StageName =>
      (STAGE_ORDER as string[]).includes(s),
    );
  }
  return STAGE_ORDER;
}

export type MiniStepDotState = "done" | "active" | "failed" | "future";

export function miniStepDots(
  sequence: StageName[],
  currentStageName: string,
  status: string,
): MiniStepDotState[] {
  const idx = sequence.indexOf(currentStageName as StageName);
  return sequence.map((_, i) => {
    if (idx === -1) return "future";
    if (i < idx) return "done";
    if (i === idx) return status === "failed" ? "failed" : "active";
    return "future";
  });
}
