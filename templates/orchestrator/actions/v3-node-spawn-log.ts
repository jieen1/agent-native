/**
 * node.spawn_log — return spawn logs for all attempts on a node (design §8.5).
 *
 * G21: new action file for missing node.spawn_log tool.
 */

import { defineAction } from "@agent-native/core";
import { eq, and, asc } from "drizzle-orm";
import { z } from "zod";
import { getV3Db, v3Schema } from "../server/db/v3.js";

export const nodeSpawnLog = defineAction({
  description:
    "Return spawn logs for a node within a V3 run. " +
    "By default returns all attempts; pass `attempt` to get a specific attempt number. " +
    "Returns spawn metadata and log content for each matching spawn.",
  schema: z.object({
    runId: z.string().min(1),
    nodeId: z.string().min(1),
    /** Specific attempt number (1-indexed). Omit for all attempts. */
    attempt: z.number().int().positive().optional(),
  }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    const db = getV3Db();

    // Verify node exists in run
    const nodeRows = await db
      .select({
        id: v3Schema.v3Nodes.id,
        nodeIdInDag: v3Schema.v3Nodes.nodeIdInDag,
        status: v3Schema.v3Nodes.status,
      })
      .from(v3Schema.v3Nodes)
      .where(
        and(
          eq(v3Schema.v3Nodes.id, args.nodeId),
          eq(v3Schema.v3Nodes.runId, args.runId),
        ),
      )
      .limit(1);

    if (!nodeRows.length) {
      throw new Error(`Node '${args.nodeId}' not found in run '${args.runId}'`);
    }

    const node = nodeRows[0];

    // Find spawns for this node
    const spawnConditions: Array<import("drizzle-orm").SQL> = [
      eq(v3Schema.v3Spawns.nodeId, args.nodeId),
    ];
    if (args.attempt !== undefined) {
      spawnConditions.push(eq(v3Schema.v3Spawns.attempt, args.attempt));
    }

    const spawnRows = await db
      .select({
        id: v3Schema.v3Spawns.id,
        attempt: v3Schema.v3Spawns.attempt,
        agentName: v3Schema.v3Spawns.agentName,
        runtime: v3Schema.v3Spawns.runtime,
        engineRef: v3Schema.v3Spawns.engineRef,
        modelRef: v3Schema.v3Spawns.modelRef,
        status: v3Schema.v3Spawns.status,
        logRef: v3Schema.v3Spawns.logRef,
        tokensInput: v3Schema.v3Spawns.tokensInput,
        tokensOutput: v3Schema.v3Spawns.tokensOutput,
        latencyMs: v3Schema.v3Spawns.latencyMs,
        error: v3Schema.v3Spawns.error,
        errorClass: v3Schema.v3Spawns.errorClass,
        startedAt: v3Schema.v3Spawns.startedAt,
        completedAt: v3Schema.v3Spawns.completedAt,
      })
      .from(v3Schema.v3Spawns)
      .where(and(...spawnConditions))
      .orderBy(asc(v3Schema.v3Spawns.attempt));

    // Fetch log artifacts for all spawns
    const logRefs = spawnRows.map((s) => s.logRef).filter(Boolean) as string[];

    const logMap = new Map<string, string | null>();
    if (logRefs.length > 0) {
      for (const ref of logRefs) {
        const artRows = await db
          .select({ textContent: v3Schema.v3Artifacts.textContent })
          .from(v3Schema.v3Artifacts)
          .where(eq(v3Schema.v3Artifacts.id, ref))
          .limit(1);

        logMap.set(ref, artRows[0]?.textContent ?? `[log ref: ${ref}]`);
      }
    }

    const spawns = spawnRows.map((s) => ({
      spawnId: s.id,
      attempt: s.attempt,
      agentName: s.agentName,
      runtime: s.runtime,
      engineRef: s.engineRef,
      modelRef: s.modelRef,
      status: s.status,
      tokensInput: s.tokensInput,
      tokensOutput: s.tokensOutput,
      latencyMs: s.latencyMs,
      error: s.error ?? null,
      errorClass: s.errorClass ?? null,
      startedAt: s.startedAt?.toISOString() ?? null,
      completedAt: s.completedAt?.toISOString() ?? null,
      log: s.logRef ? (logMap.get(s.logRef) ?? null) : null,
    }));

    return {
      nodeId: node.id,
      nodeIdInDag: node.nodeIdInDag,
      status: node.status,
      spawns,
      totalAttempts: spawns.length,
    };
  },
});
