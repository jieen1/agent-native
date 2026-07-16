/**
 * Pure helpers behind WorkItemDetailPage's header controls — extracted so
 * the escalate-guard and stage-neighbor math can be unit-tested without
 * mounting the full page (this template's page-level tests are logic-only;
 * see app/lib/__tests__/split-draft.test.ts).
 */

export interface StageNeighbors {
  nextStage: string | null;
  prevStage: string | null;
}

/** The stage immediately after/before `currentStageName` in `stageOrder`, or
 *  null past either end. Shared by the header's 触发下一阶段 / 回退阶段
 *  controls so both compute the same answer from the same planned-stage
 *  list instead of duplicating the index math inline. */
export function stageNeighbors(
  stageOrder: readonly string[],
  currentStageName: string,
): StageNeighbors {
  const idx = stageOrder.indexOf(currentStageName);
  return {
    nextStage:
      idx >= 0 && idx < stageOrder.length - 1 ? stageOrder[idx + 1]! : null,
    prevStage: idx > 0 ? stageOrder[idx - 1]! : null,
  };
}

/**
 * Whether the header's "升级至裁决" control has a real action to call.
 * `request-approval` (templates/tracker/actions/request-approval.ts)
 * requires a `sprintId` — an item with no sprint has nothing to escalate
 * against, so the button must not render at all rather than render
 * disabled/fake. Mirrors app/lib/inbox.ts's `canEscalate`, which guards the
 * identical control on the Inbox's failed-routing cards.
 */
export function canEscalateWorkItem(
  sprint: { id: string } | null | undefined,
): boolean {
  return !!sprint?.id;
}
