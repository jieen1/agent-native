// M5 度量复盘 — Sprint 燃尽 (burndown) derivation (pure, framework-free).
//
// Server-side sibling of app/lib/sprint-metrics.ts's `computeBurndown`, shaped
// for the sprint-status action: instead of returning `null` it returns an
// explicit `emptyReason` so the UI can render an HONEST empty state ("no items
// yet", "no start date", "too new to plot", "sprint ran too long") rather than
// a fabricated chart. Every point is derived from REAL rows (交付 stage
// completedAt, falling back to a terminal item's updatedAt) — never invented.

import type { BurndownEmptyReason, BurndownPoint } from "./types.js";

const DAY_MS = 86_400_000;
/** Sprints running longer than this are not plotted — the sparkline is meant
 *  for a single time-boxed sprint, not open-ended history. */
const MAX_DAYS = 120;

export interface BurndownInput {
  items: Array<{ id: string; status: string; updatedAt: string }>;
  stages: Array<{
    workItemId: string;
    stageName: string;
    completedAt: string | null;
  }>;
  startDate: string | null | undefined;
  /** Right boundary — defaults to now. */
  now?: Date;
}

export interface BurndownDerivation {
  points: BurndownPoint[];
  total: number;
  /** Non-null exactly when `points` is empty — the honest reason why. */
  emptyReason: BurndownEmptyReason | null;
}

/**
 * One item's real "delivered at" timestamp (ms), or undefined if not delivered
 * yet. Prefers the 交付 stage's completedAt (strongest signal); falls back to
 * the item's own updatedAt only when its status is terminal done/closed but no
 * 交付 stage row exists (legacy / hand-closed items).
 */
function deliveredAtMs(
  item: { id: string; status: string; updatedAt: string },
  deliveryStageMs: Map<string, number>,
): number | undefined {
  const viaStage = deliveryStageMs.get(item.id);
  if (viaStage !== undefined) return viaStage;
  if (item.status === "done" || item.status === "closed") {
    const t = new Date(item.updatedAt).getTime();
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}

export function deriveBurndown(input: BurndownInput): BurndownDerivation {
  const now = input.now ?? new Date();
  const total = input.items.length;
  if (total === 0) {
    return { points: [], total, emptyReason: "no-items" };
  }
  if (!input.startDate) {
    return { points: [], total, emptyReason: "no-start-date" };
  }
  const start = new Date(input.startDate);
  if (Number.isNaN(start.getTime())) {
    return { points: [], total, emptyReason: "no-start-date" };
  }

  const deliveryStageMs = new Map<string, number>();
  for (const s of input.stages) {
    if (s.stageName !== "交付" || !s.completedAt) continue;
    const t = new Date(s.completedAt).getTime();
    if (!Number.isFinite(t)) continue;
    const prev = deliveryStageMs.get(s.workItemId);
    if (prev === undefined || t < prev) deliveryStageMs.set(s.workItemId, t);
  }

  const deliveredMs: number[] = [];
  for (const item of input.items) {
    const t = deliveredAtMs(item, deliveryStageMs);
    if (t !== undefined) deliveredMs.push(t);
  }

  const startDay = Date.UTC(
    start.getFullYear(),
    start.getMonth(),
    start.getDate(),
  );
  const endDay = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const dayCount = Math.round((endDay - startDay) / DAY_MS) + 1;
  if (dayCount < 2) return { points: [], total, emptyReason: "too-new" };
  if (dayCount > MAX_DAYS) return { points: [], total, emptyReason: "too-long" };

  const points: BurndownPoint[] = [];
  for (let i = 0; i < dayCount; i++) {
    const dayEndMs = startDay + i * DAY_MS + DAY_MS - 1;
    const deliveredBy = deliveredMs.filter((t) => t <= dayEndMs).length;
    const date = new Date(startDay + i * DAY_MS).toISOString().slice(0, 10);
    points.push({ date, remaining: total - deliveredBy });
  }
  return { points, total, emptyReason: null };
}
