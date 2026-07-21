import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

// M5 度量复盘 — Sprint burndown chart data.
//
// Derives `remaining` counts from real DB rows: 交付 stage completedAt is the
// primary delivery signal; falls back to item.updatedAt when status is
// "done"|"closed" and no 交付 stage row exists (legacy / hand-closed items).
// Only items belonging to this sprint are counted. Returns null series when
// startDate is missing or the sprint spans < 2 days.

const DAY_MS = 86_400_000;
const MAX_DAYS = 120;

export default defineAction({
  description:
    "Return the burndown series (remaining work items per day) for a sprint. " +
    "Derived from real tracker stage completedAt timestamps and item status — " +
    "never fabricated. Returns an empty series when startDate is missing or the " +
    "sprint is too new to plot.",
  schema: z.object({
    sprintId: z.string().min(1).describe("Sprint id"),
  }),
  http: { method: "GET" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

    const db = getDb();
    const sprint = (
      await db
        .select({
          id: schema.sprints.id,
          startDate: schema.sprints.startDate,
          endDate: schema.sprints.endDate,
        })
        .from(schema.sprints)
        .where(
          and(eq(schema.sprints.id, args.sprintId), ownerScope(schema.sprints)),
        )
        .limit(1)
    )[0];
    if (!sprint) throw new Error("Sprint not found or not accessible");

    const items = await db
      .select({
        id: schema.workItems.id,
        status: schema.workItems.status,
        updatedAt: schema.workItems.updatedAt,
      })
      .from(schema.workItems)
      .where(eq(schema.workItems.sprintId, args.sprintId));

    const totalItems = items.length;

    if (totalItems === 0 || !sprint.startDate) {
      return {
        sprintId: args.sprintId,
        series: [] as Array<{ date: string; remaining: number }>,
        totalItems,
      };
    }

    const start = new Date(sprint.startDate);
    if (Number.isNaN(start.getTime())) {
      return { sprintId: args.sprintId, series: [], totalItems };
    }

    // Pull 交付 stages for all items in this sprint.
    const stageRows =
      items.length > 0
        ? await db
            .select({
              workItemId: schema.stages.workItemId,
              stageName: schema.stages.stageName,
              completedAt: schema.stages.completedAt,
            })
            .from(schema.stages)
            .where(
              inArray(
                schema.stages.workItemId,
                items.map((i) => i.id),
              ),
            )
        : [];

    // Build: workItemId → earliest 交付 completedAt (ms).
    const deliveryStageMs = new Map<string, number>();
    for (const s of stageRows) {
      if (s.stageName !== "交付" || !s.completedAt) continue;
      const t = new Date(s.completedAt).getTime();
      if (!Number.isFinite(t)) continue;
      const prev = deliveryStageMs.get(s.workItemId);
      if (prev === undefined || t < prev) deliveryStageMs.set(s.workItemId, t);
    }

    // Resolve each item's delivery timestamp (ms), or undefined = not done.
    const deliveredMs: number[] = [];
    for (const item of items) {
      const viaStage = deliveryStageMs.get(item.id);
      if (viaStage !== undefined) {
        deliveredMs.push(viaStage);
        continue;
      }
      if (item.status === "done" || item.status === "closed") {
        const t = new Date(item.updatedAt).getTime();
        if (Number.isFinite(t)) deliveredMs.push(t);
      }
    }

    const now = new Date();
    // Use endDate as the right boundary if it's in the past; otherwise today.
    const endBoundary =
      sprint.endDate && new Date(sprint.endDate).getTime() < now.getTime()
        ? new Date(sprint.endDate)
        : now;

    const startDay = Date.UTC(
      start.getFullYear(),
      start.getMonth(),
      start.getDate(),
    );
    const endDay = Date.UTC(
      endBoundary.getFullYear(),
      endBoundary.getMonth(),
      endBoundary.getDate(),
    );
    const dayCount = Math.round((endDay - startDay) / DAY_MS) + 1;

    if (dayCount < 2 || dayCount > MAX_DAYS) {
      return { sprintId: args.sprintId, series: [], totalItems };
    }

    const series: Array<{ date: string; remaining: number }> = [];
    for (let i = 0; i < dayCount; i++) {
      const dayEndMs = startDay + i * DAY_MS + DAY_MS - 1;
      const deliveredBy = deliveredMs.filter((t) => t <= dayEndMs).length;
      const date = new Date(startDay + i * DAY_MS).toISOString().slice(0, 10);
      series.push({ date, remaining: totalItems - deliveredBy });
    }

    return { sprintId: args.sprintId, series, totalItems };
  },
});
