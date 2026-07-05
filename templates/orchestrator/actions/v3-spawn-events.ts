/**
 * spawn.events — return a spawn's INTERMEDIATE execution transcript
 * (DESIGN §8.5). The run-detail Node Inspector's "执行过程 / Execution" timeline
 * reads this to replay a node's real reasoning + tool calls + tool results,
 * instead of only a tool-call count.
 *
 * Rows come from the additive `spawn_events` table the dispatcher now writes
 * after each spawn (claude-code analyze/review + vLLM develop). The parent spawn
 * lookup is FAIL-CLOSED owner-scoped, so a foreign spawn's transcript is not
 * readable; the events themselves belong to that owned spawn.
 */

import { defineAction } from "@agent-native/core";
import { and, eq, asc } from "drizzle-orm";
import { z } from "zod";
import { getV3Db, v3Schema, resolveOwnerEmail } from "../server/db/index.js";

/** One ordered step in a spawn's execution timeline. */
export interface V3SpawnEvent {
  id: string;
  seq: number;
  /** text | tool_use | tool_result */
  type: string;
  /** Tool name for tool_use / tool_result steps. */
  name: string | null;
  /** Tool input (tool_use). */
  input: unknown;
  /** Tool result (tool_result). */
  result: unknown;
  /** Assistant reasoning/answer text for `text` steps. */
  text: string | null;
}

export const spawnEvents = defineAction({
  description:
    "Return the ordered intermediate execution transcript for a V3 spawn: each " +
    "assistant reasoning text, every tool call (name + input), and every tool " +
    "result, ordered by seq. Powers the run-detail Node Inspector execution " +
    "timeline. Returns an empty list for spawns that recorded no steps (e.g. a " +
    "node that did no tool calls, or a run from before step capture landed).",
  schema: z.object({
    spawnId: z.string().min(1),
  }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    const db = getV3Db();

    // Verify the spawn exists AND belongs to the resolved owner (fail-closed).
    const spawnRows = await db
      .select({
        id: v3Schema.v3Spawns.id,
        nodeId: v3Schema.v3Spawns.nodeId,
        status: v3Schema.v3Spawns.status,
      })
      .from(v3Schema.v3Spawns)
      .where(
        and(
          eq(v3Schema.v3Spawns.id, args.spawnId),
          eq(v3Schema.v3Spawns.ownerEmail, resolveOwnerEmail()),
        ),
      )
      .limit(1);

    if (!spawnRows.length) {
      throw new Error(`Spawn '${args.spawnId}' not found`);
    }

    let runId: string | null = null;
    if (spawnRows[0].nodeId) {
      const nodeRows = await db
        .select({ runId: v3Schema.v3Nodes.runId })
        .from(v3Schema.v3Nodes)
        .where(eq(v3Schema.v3Nodes.id, spawnRows[0].nodeId))
        .limit(1);
      runId = nodeRows[0]?.runId ?? null;
    }

    const rows = await db
      .select({
        id: v3Schema.spawnEvents.id,
        seq: v3Schema.spawnEvents.seq,
        type: v3Schema.spawnEvents.type,
        name: v3Schema.spawnEvents.name,
        input: v3Schema.spawnEvents.input,
        result: v3Schema.spawnEvents.result,
        text: v3Schema.spawnEvents.text,
      })
      .from(v3Schema.spawnEvents)
      .where(eq(v3Schema.spawnEvents.spawnId, args.spawnId))
      .orderBy(asc(v3Schema.spawnEvents.seq));

    const events: V3SpawnEvent[] = rows.map((r) => ({
      id: r.id,
      seq: r.seq,
      type: r.type,
      name: r.name ?? null,
      input: r.input ?? null,
      result: r.result ?? null,
      text: r.text ?? null,
    }));

    return {
      spawnId: args.spawnId,
      runId,
      status: spawnRows[0].status,
      events,
      total: events.length,
    };
  },
});
