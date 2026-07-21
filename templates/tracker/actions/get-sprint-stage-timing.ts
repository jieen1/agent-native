import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import { callOrchestratorTool } from "../server/lib/orchestrator-client.js";
import {
  deriveWorkItemTimings,
  type NodeTimingRow,
  type SpawnTimingRow,
} from "../shared/sprint-timing.js";

// M5 度量复盘 — per-work-item stage timing for the sprint cockpit.
//
// Every duration is derived NATIVELY from real orchestrator `v3_spawns`
// timestamps (started_at / completed_at), read back over the SAME structured
// MCP `tools/call` channel get-activity.ts already uses (spawnList + v3RunNodes).
// No JSONL transcript mining, no fabricated numbers: a stage with no spawn data
// comes back as `no data` (totalSec=null). See shared/sprint-timing.ts for the
// pure derivation + the exact column mapping.

interface ItemRow {
  id: string;
  itemKey: string;
  title: string;
  ownerEmail: string;
  orchestratorRunId: string | null;
}

export default defineAction({
  description:
    "Derive per-work-item stage timing (dev/qa/review/gate) for a sprint from " +
    "real orchestrator v3_spawns started_at/completed_at timestamps. Stages with " +
    "no spawn data are reported as `no data`, never 0.",
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
        orchestratorRunId: schema.workItems.orchestratorRunId,
      })
      .from(schema.workItems)
      .where(eq(schema.workItems.sprintId, args.sprintId));

    const items = rawItems as ItemRow[];
    const workItemIds = items.map((i) => i.id);
    const errors: Record<string, string> = {};

    // ── Pull real spawns, grouped by the dispatching owner ─────────────────
    // spawnList is owner-scoped on the orchestrator side, so we must call it as
    // the owner who actually dispatched each item (get-activity.ts's same rule).
    // One call per distinct owner with a tracker tagMatch, then filter to this
    // sprint's items client-side by tags.item_id.
    const spawns: SpawnTimingRow[] = [];
    const owners = [...new Set(items.map((i) => i.ownerEmail))];
    await Promise.all(
      owners.map(async (owner) => {
        try {
          const { data } = await callOrchestratorTool(owner, "spawnList", {
            tagMatch: { source: "tracker" },
            limit: 500,
          });
          if (Array.isArray(data)) {
            for (const row of data as Array<Record<string, unknown>>) {
              spawns.push({
                id: String(row.id ?? ""),
                nodeId: (row.nodeId as string | null) ?? null,
                runId: (row.runId as string | null) ?? null,
                status: String(row.status ?? ""),
                tags: row.tags,
                startedAt: (row.startedAt as string | null) ?? null,
                completedAt: (row.completedAt as string | null) ?? null,
              });
            }
          }
        } catch (e) {
          errors[`spawns:${owner}`] = String(
            (e as Error)?.message ?? e,
          );
        }
      }),
    );

    // ── Resolve each spawn's node → DAG id (for staging) via v3RunNodes ────
    const runIds = [
      ...new Set(spawns.map((s) => s.runId).filter((r): r is string => !!r)),
    ];
    const nodes: NodeTimingRow[] = [];
    await Promise.all(
      runIds.map(async (runId) => {
        // v3RunNodes is owner-scoped to the run's owner; try each owner until
        // one can read it (best-effort — a miss just leaves those nodes
        // unstaged, which surfaces as `no data`, never a wrong number).
        for (const owner of owners) {
          try {
            const { data } = await callOrchestratorTool(owner, "v3RunNodes", {
              runId,
            });
            if (Array.isArray(data)) {
              for (const n of data as Array<Record<string, unknown>>) {
                nodes.push({
                  id: String(n.id ?? ""),
                  nodeIdInDag: String(n.nodeIdInDag ?? ""),
                });
              }
              return;
            }
          } catch {
            // try next owner
          }
        }
      }),
    );

    const timings = deriveWorkItemTimings(spawns, nodes, workItemIds);
    const byId = new Map(timings.map((t) => [t.workItemId, t]));

    return {
      sprintId: args.sprintId,
      items: items.map((i) => ({
        workItemId: i.id,
        itemKey: i.itemKey,
        title: i.title,
        stages: byId.get(i.id)?.stages ?? [],
      })),
      errors: Object.keys(errors).length ? errors : undefined,
    };
  },
});
