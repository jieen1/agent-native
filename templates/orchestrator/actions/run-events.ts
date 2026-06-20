import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";

// run-events (DESIGN §4.4): the ordered event stream for the run console /
// canvas overlay. `sinceSeq` returns only newer events so a poller appends.
//
// APPROACH — polling event log derived from NodeRun status transitions.
// The framework's `subscribeToRun(runId, fromSeq)` (agent run-manager) bridges
// an AGENT run's live SSE; the P1 v2 engine is the deterministic SCHEDULER, not
// an agent run-manager run, so there is no such stream to bridge yet. Instead we
// DERIVE a stable event log from the journaled `node_runs` transitions (the same
// rows the canvas reads): every NodeRun emits a `started` event at `started_at`
// and a `settled` event at `completed_at` carrying its terminal status. Events
// are ordered by (timestamp, nodeId, iteration, fanoutIndex, phase) and assigned
// a monotonic `seq`; `sinceSeq` filters by it. When P2/P3 wire the scheduler
// into a real run-manager stream this action's SHAPE (seq + ordered events) is
// the bridge target, so the UI contract does not change.
type EventPhase = "started" | "settled";

interface RunEvent {
  seq: number;
  type: string;
  nodeRunId: string;
  nodeId: string;
  status: string;
  iteration: number;
  fanoutIndex: number;
  dynamic: boolean;
  at: string;
}

export default defineAction({
  description:
    "Get a run's ordered event log (NodeRun started/settled transitions). Pass `sinceSeq` to fetch only newer events for the run console / canvas overlay.",
  schema: z.object({
    runId: z.string(),
    sinceSeq: z.coerce.number().int().min(0).optional(),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args) => {
    const access = await resolveAccess("workflow_run", args.runId);
    if (!access) throw new Error(`Run ${args.runId} not found`);
    const run = access.resource as Record<string, unknown>;
    const db = getDb();

    const rows = await db
      .select()
      .from(schema.nodeRuns)
      .where(eq(schema.nodeRuns.runId, args.runId));

    // Build raw (timestamp, phase) events from every transition that has a time.
    const raw: Array<{
      at: string;
      phase: EventPhase;
      nodeRunId: string;
      nodeId: string;
      status: string;
      iteration: number;
      fanoutIndex: number;
      dynamic: boolean;
    }> = [];
    for (const nr of rows) {
      const base = {
        nodeRunId: nr.id,
        nodeId: nr.nodeId,
        iteration: nr.iteration,
        fanoutIndex: nr.fanoutIndex,
        dynamic: nr.dynamic === 1,
      };
      if (nr.startedAt) {
        raw.push({
          ...base,
          at: nr.startedAt,
          phase: "started",
          status: "running",
        });
      }
      if (nr.completedAt) {
        raw.push({
          ...base,
          at: nr.completedAt,
          phase: "settled",
          status: nr.status,
        });
      }
    }

    // Deterministic order: by time, then node key, then phase (started<settled).
    const phaseRank: Record<EventPhase, number> = { started: 0, settled: 1 };
    raw.sort((a, b) => {
      if (a.at !== b.at) return a.at < b.at ? -1 : 1;
      if (a.nodeId !== b.nodeId) return a.nodeId < b.nodeId ? -1 : 1;
      if (a.iteration !== b.iteration) return a.iteration - b.iteration;
      if (a.fanoutIndex !== b.fanoutIndex) return a.fanoutIndex - b.fanoutIndex;
      return phaseRank[a.phase] - phaseRank[b.phase];
    });

    const sinceSeq = args.sinceSeq ?? 0;
    const events: RunEvent[] = raw
      .map((e, i) => ({
        seq: i + 1,
        type: `node-${e.phase}`,
        nodeRunId: e.nodeRunId,
        nodeId: e.nodeId,
        status: e.status,
        iteration: e.iteration,
        fanoutIndex: e.fanoutIndex,
        dynamic: e.dynamic,
        at: e.at,
      }))
      .filter((e) => e.seq > sinceSeq);

    return {
      runId: args.runId,
      runStatus: run.status as string,
      lastSeq: raw.length,
      events,
    };
  },
});
