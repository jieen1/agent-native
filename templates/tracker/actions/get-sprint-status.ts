import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import { fetchSprintSpawnsBatched } from "../server/lib/sprint-spawn-fetch.js";
import { deriveBurndown } from "../shared/sprint-burndown.js";
import { deriveWorkItemTimings } from "../shared/sprint-timing.js";

// M5 度量复盘 — Sprint 状态总览 (sprint-status + 燃尽 + 实走验证 timing).
//
// One read path that the Sprint 驾驶舱's status panel renders:
//   - sprint-status: status/phase + delivered/total counts (real DB rows).
//   - 燃尽 (burndown): derived from REAL 交付 stage completedAt (fallback: a
//     terminal item's updatedAt) via shared/sprint-burndown.ts. Honest empty
//     states carry an explicit `burndownEmptyReason` — NEVER a fabricated point.
//   - 实走验证 timing: per-work-item dev/qa/review/gate durations derived
//     NATIVELY from real orchestrator v3_spawns timestamps via the BATCHED
//     cross-app fetch (server/lib/sprint-spawn-fetch.ts). On orchestrator
//     error/timeout it degrades to an honest empty state (timingDegraded=true,
//     all stages 无数据) rather than throwing or inventing numbers.

export default defineAction({
  description:
    "Sprint status overview: status/phase + delivered counts, the burndown " +
    "series (real 交付 completedAt, honest empty states), and per-work-item " +
    "stage timing derived from real orchestrator v3_spawns timestamps. The " +
    "cross-app spawn fetch is batched and degrades honestly on error/timeout.",
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
          status: schema.sprints.status,
          phase: schema.sprints.phase,
          startDate: schema.sprints.startDate,
        })
        .from(schema.sprints)
        .where(
          and(eq(schema.sprints.id, args.sprintId), ownerScope(schema.sprints)),
        )
        .limit(1)
    )[0];
    if (!sprint) throw new Error("Sprint not found or not accessible");

    const rawItems = await db
      .select({
        id: schema.workItems.id,
        itemKey: schema.workItems.itemKey,
        title: schema.workItems.title,
        status: schema.workItems.status,
        updatedAt: schema.workItems.updatedAt,
        ownerEmail: schema.workItems.ownerEmail,
      })
      .from(schema.workItems)
      .where(eq(schema.workItems.sprintId, args.sprintId));

    const stageRows =
      rawItems.length > 0
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
                rawItems.map((i) => i.id),
              ),
            )
        : [];

    // ── 燃尽 (burndown) from real rows — honest empty states ───────────────
    const burndown = deriveBurndown({
      items: rawItems.map((i) => ({
        id: i.id,
        status: i.status,
        updatedAt: i.updatedAt,
      })),
      stages: stageRows.map((s) => ({
        workItemId: s.workItemId,
        stageName: s.stageName,
        completedAt: s.completedAt,
      })),
      startDate: sprint.startDate,
    });

    // ── 实走验证 timing from real v3_spawns — batched, degrades honestly ───
    const workItemIds = rawItems.map((i) => i.id);
    const itemMeta = new Map(
      rawItems.map((i) => [i.id, { itemKey: i.itemKey, title: i.title }]),
    );
    const owners = [...new Set(rawItems.map((i) => i.ownerEmail))];
    const { spawns, nodes, degraded, errors } =
      await fetchSprintSpawnsBatched(owners);
    const timings = deriveWorkItemTimings(spawns, nodes, workItemIds, itemMeta);

    return {
      sprintId: args.sprintId,
      status: sprint.status ?? "",
      phase: sprint.phase,
      totalItems: rawItems.length,
      delivered: rawItems.filter((i) => i.status === "done").length,
      burndown: burndown.points,
      burndownEmptyReason: burndown.emptyReason,
      timings,
      timingDegraded: degraded,
      errors: Object.keys(errors).length ? errors : undefined,
    };
  },
});
