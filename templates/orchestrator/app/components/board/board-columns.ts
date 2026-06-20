// Board column derivation (FRONTEND §2 "Board layout"). Pure helpers that turn a
// project's resolved scheme set + the active filters into the kanban's columns.
// Shared by the board route and the project-detail board so the column logic
// lives in ONE place.

import type {
  SchemeSet,
  StatusCategory,
  StatusScheme,
} from "../../../shared/status-schemes";
import type { ExecState, WorkItem, WorkItemType } from "@/hooks/use-work-items";

export const CATEGORY_ORDER: StatusCategory[] = [
  "todo",
  "in-progress",
  "completed",
  "cancelled",
];

export const EXEC_LANES: ExecState[] = [
  "idle",
  "queued",
  "claimed",
  "running",
  "paused",
  "failed",
];

export interface BoardColumn {
  /** Column id — a category key (all-types view) or a stage key (one-type view). */
  id: string;
  /** The category this column maps to (drives the color + the drop target). */
  category: StatusCategory;
  /** Whether dropping a card here is a category drop (needs a concrete stage). */
  byCategory: boolean;
  /** The concrete target stage for a drop (set on stage columns). */
  targetStage?: string;
}

/**
 * All-types view → 4 category columns. The cancelled column is included but the
 * caller may render it collapsed.
 */
export function categoryColumns(): BoardColumn[] {
  return CATEGORY_ORDER.map((category) => ({
    id: category,
    category,
    byCategory: true,
  }));
}

/**
 * One-type view → the type's full pipeline as stage columns, in scheme order,
 * each carrying its concrete target stage.
 */
export function stageColumns(scheme: StatusScheme): BoardColumn[] {
  return scheme.stages
    .filter((s) => !s.deprecated)
    .map((s) => ({
      id: s.key,
      category: s.category,
      byCategory: false,
      targetStage: s.key,
    }));
}

/** Resolve the scheme for a single type from the project's resolved set. */
export function schemeForType(
  schemes: SchemeSet | undefined,
  type: WorkItemType,
): StatusScheme | null {
  return schemes?.[type] ?? null;
}

/**
 * The concrete target stage a category-column drop should land on. The first
 * non-terminal stage of that category is the natural "move here" target; for a
 * terminal category we can't auto-pick (resolution required) so we return null
 * and the drop is rejected by the validator (the caller toasts).
 */
export function firstStageOfCategory(
  scheme: StatusScheme,
  category: StatusCategory,
): string | null {
  const stage = scheme.stages.find(
    (s) => s.category === category && !s.deprecated,
  );
  return stage?.key ?? null;
}

/** Group items into columns (board view). Sorts by priority then updatedAt. */
export function groupByColumn(
  items: WorkItem[],
  columns: BoardColumn[],
): Map<string, WorkItem[]> {
  const map = new Map<string, WorkItem[]>();
  for (const col of columns) map.set(col.id, []);
  for (const item of items) {
    if (columns[0]?.byCategory) {
      const colId = item.statusCategory;
      if (map.has(colId)) map.get(colId)!.push(item);
    } else {
      if (map.has(item.status)) map.get(item.status)!.push(item);
    }
  }
  for (const [, list] of map) {
    list.sort(
      (a, b) =>
        a.priority - b.priority || b.updatedAt.localeCompare(a.updatedAt),
    );
  }
  return map;
}

/** Group items into execState lanes (queue view). */
export function groupByExec(items: WorkItem[]): Map<ExecState, WorkItem[]> {
  const map = new Map<ExecState, WorkItem[]>();
  for (const lane of EXEC_LANES) map.set(lane, []);
  for (const item of items) {
    const lane = (item.execState === "done" ? "idle" : item.execState) as ExecState;
    if (map.has(lane)) map.get(lane)!.push(item);
  }
  for (const [, list] of map) {
    list.sort(
      (a, b) =>
        a.priority - b.priority || b.updatedAt.localeCompare(a.updatedAt),
    );
  }
  return map;
}
