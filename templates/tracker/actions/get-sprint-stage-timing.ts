import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import { fetchSprintSpawnsBatched } from "../server/lib/sprint-spawn-fetch.js";
import { deriveWorkItemTimings } from "../shared/sprint-timing.js";

// M5 度量复盘 — per-work-item stage timing (实走验证 timing) for the sprint
// cockpit.
//
// Every duration is derived NATIVELY from real orchestrator `v3_spawns`
// started_at / completed_at timestamps, read back over the SAME structured MCP
// `tools/call` channel get-activity.ts already uses (spawnList + v3RunNodes),
// centralised in server/lib/sprint-spawn-fetch.ts. No JSONL transcript mining,
// no fabricated numbers: a stage with no spawn data comes back as 无数据
// (totalSec=null). The cross-app fetch is BATCHED (one spawnList call per
// distinct dispatching owner, grouped client-side — NO per-item N+1) and
// degrades to an honest empty state on spawnList error/timeout (degraded=true)
// rather than throwing.

export default defineAction({
  description:
    "Derive per-work-item stage timing (dev/qa/review/gate) for a sprint from " +
    "real orchestrator v3_spawns started_at/completed_at timestamps. Stages " +
    "with no spawn data are reported as 无数据 (no data), never 0. Batched " +
    "cross-app fetch; degrades honestly on orchestrator error/timeout.",
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
        .select({ id: schema.sprints.id })
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
        ownerEmail: schema.workItems.ownerEmail,
      })
      .from(schema.workItems)
      .where(eq(schema.workItems.sprintId, args.sprintId));

    const workItemIds = rawItems.map((i) => i.id);
    const itemMeta = new Map(
      rawItems.map((i) => [i.id, { itemKey: i.itemKey, title: i.title }]),
    );

    // BATCHED cross-app fetch: one spawnList call per distinct dispatching
    // owner, then grouped by work-item id client-side (no N+1). Degrades to an
    // honest empty state (degraded=true) on error/timeout — never throws.
    const owners = [...new Set(rawItems.map((i) => i.ownerEmail))];
    const { spawns, nodes, degraded, errors } =
      await fetchSprintSpawnsBatched(owners);

    const timings = deriveWorkItemTimings(spawns, nodes, workItemIds, itemMeta);

    return {
      sprintId: args.sprintId,
      items: timings,
      degraded,
      errors: Object.keys(errors).length ? errors : undefined,
    };
  },
});
