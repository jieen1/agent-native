// Pure logic for the Sprint 驾驶舱's 度量摘要 (SprintDetailPage.tsx, S6
// s6-sprint-cockpit.html ~554-565). Framework-free (no React) so it's unit
// testable without a DOM, mirroring app/lib/queue.ts's convention.
//
// Both functions only ever derive numbers from REAL rows already returned by
// get-sprint (items + stages) — no fabricated chart data. Callers must render
// an honest empty state when either returns null / an empty array (e.g. no
// startDate, insufficient history, or zero completed stages) rather than
// inventing a plausible-looking chart.
import type { Stage, TrackerWorkItem } from "@shared/types";

// ── Burndown (剩 X/Y) ─────────────────────────────────────────────────────────

export interface BurndownPoint {
  /** MM-DD label. */
  date: string;
  remaining: number;
}

export interface BurndownResult {
  points: BurndownPoint[];
  total: number;
}

const DAY_MS = 86_400_000;
/** Sprints running longer than this are not plotted — the sparkline is meant
 *  for a single time-boxed sprint, not an open-ended history. */
const MAX_DAYS = 120;

/**
 * One item's real "delivered at" timestamp, or undefined if it hasn't been
 * delivered yet. Prefers the 交付 stage's completedAt (the strongest signal);
 * falls back to the item's own updatedAt only when its status is a terminal
 * done/closed but no 交付 stage row exists (legacy / hand-closed items).
 */
function deliveredAtMs(
  item: Pick<TrackerWorkItem, "id" | "status" | "updatedAt">,
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

export function computeBurndown(
  items: Pick<TrackerWorkItem, "id" | "status" | "updatedAt">[],
  stages: Pick<Stage, "workItemId" | "stageName" | "completedAt">[],
  startDate: string | null | undefined,
  now: Date = new Date(),
): BurndownResult | null {
  const total = items.length;
  if (total === 0) return null;
  if (!startDate) return null;
  const start = new Date(startDate);
  if (Number.isNaN(start.getTime())) return null;

  const deliveryStageMs = new Map<string, number>();
  for (const s of stages) {
    if (s.stageName !== "交付" || !s.completedAt) continue;
    const t = new Date(s.completedAt).getTime();
    if (!Number.isFinite(t)) continue;
    const prev = deliveryStageMs.get(s.workItemId);
    if (prev === undefined || t < prev) deliveryStageMs.set(s.workItemId, t);
  }

  const deliveredMs: number[] = [];
  for (const item of items) {
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
  if (dayCount < 2 || dayCount > MAX_DAYS) return null;

  const points: BurndownPoint[] = [];
  for (let i = 0; i < dayCount; i++) {
    const dayEndMs = startDay + i * DAY_MS + DAY_MS - 1;
    const deliveredBy = deliveredMs.filter((t) => t <= dayEndMs).length;
    const label = new Date(startDay + i * DAY_MS).toISOString().slice(5, 10);
    points.push({ date: label, remaining: total - deliveredBy });
  }
  return { points, total };
}

// ── Median stage duration (dev/qa/review/gate 概念的 tracker 版) ─────────────

export interface StageDuration {
  stageName: string;
  minutes: number;
}

const STAGE_DURATION_ORDER = ["分析", "设计", "实施", "测试", "验收", "交付"];

export function medianStageDurationsMinutes(
  stages: Pick<Stage, "stageName" | "startedAt" | "completedAt">[],
): StageDuration[] {
  const byStage = new Map<string, number[]>();
  for (const s of stages) {
    if (!s.startedAt || !s.completedAt) continue;
    const start = new Date(s.startedAt).getTime();
    const end = new Date(s.completedAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      continue;
    }
    const minutes = (end - start) / 60_000;
    const arr = byStage.get(s.stageName);
    if (arr) arr.push(minutes);
    else byStage.set(s.stageName, [minutes]);
  }

  const result: StageDuration[] = [];
  for (const name of STAGE_DURATION_ORDER) {
    const arr = byStage.get(name);
    if (!arr || arr.length === 0) continue;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 0
        ? (sorted[mid - 1]! + sorted[mid]!) / 2
        : sorted[mid]!;
    result.push({ stageName: name, minutes: Math.round(median) });
  }
  return result;
}
