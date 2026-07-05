/**
 * node.summary — per-node detail with optional include fields (design §8.5).
 *
 * Supports include: ["full_diff", "full_log", "schema"] to pull extended content.
 *
 * G21: new action file for missing node.summary tool.
 */

import { defineAction } from "@agent-native/core";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { getV3Db, v3Schema, resolveOwnerEmail } from "../server/db/v3.js";

export const nodeSummary = defineAction({
  description:
    "Get a summary of a single V3 node within a run. " +
    "Include 'full_diff' to get the workspace diff artifact, " +
    "'full_log' to get the full spawn log, " +
    "'schema' to get the node's output_schema from the DAG definition.",
  schema: z.object({
    runId: z.string().min(1),
    nodeId: z.string().min(1),
    include: z
      .array(z.enum(["full_diff", "full_log", "schema"]))
      .optional()
      .default([]),
  }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    const db = getV3Db();

    // Load node row — fail-closed owner scope so a foreign node isn't found.
    const nodeRows = await db
      .select({
        id: v3Schema.v3Nodes.id,
        runId: v3Schema.v3Nodes.runId,
        nodeIdInDag: v3Schema.v3Nodes.nodeIdInDag,
        type: v3Schema.v3Nodes.type,
        status: v3Schema.v3Nodes.status,
        iteration: v3Schema.v3Nodes.iteration,
        fanoutIndex: v3Schema.v3Nodes.fanoutIndex,
        currentSpawnId: v3Schema.v3Nodes.currentSpawnId,
        outputArtifactId: v3Schema.v3Nodes.outputArtifactId,
        startedAt: v3Schema.v3Nodes.startedAt,
        completedAt: v3Schema.v3Nodes.completedAt,
        error: v3Schema.v3Nodes.error,
      })
      .from(v3Schema.v3Nodes)
      .where(
        and(
          eq(v3Schema.v3Nodes.id, args.nodeId),
          eq(v3Schema.v3Nodes.runId, args.runId),
          eq(v3Schema.v3Nodes.ownerEmail, resolveOwnerEmail()),
        ),
      )
      .limit(1);

    if (!nodeRows.length) {
      throw new Error(`Node '${args.nodeId}' not found in run '${args.runId}'`);
    }

    const node = nodeRows[0];

    // Load output artifact
    let output: string | null = null;
    let outputKind: string | null = null;
    let truncated = false;

    if (node.outputArtifactId) {
      const artRows = await db
        .select({
          textContent: v3Schema.v3Artifacts.textContent,
          objectContent: v3Schema.v3Artifacts.objectContent,
          truncated: v3Schema.v3Artifacts.truncated,
          kind: v3Schema.v3Artifacts.kind,
        })
        .from(v3Schema.v3Artifacts)
        .where(eq(v3Schema.v3Artifacts.id, node.outputArtifactId))
        .limit(1);

      if (artRows.length) {
        const art = artRows[0];
        output =
          art.textContent ??
          (art.objectContent != null ? JSON.stringify(art.objectContent, null, 2) : null);
        outputKind = art.kind;
        truncated = Boolean(art.truncated);
      }
    }

    // Load spawn metadata (current or latest attempt)
    let spawn: {
      id: string;
      agentName: string | null;
      runtime: string | null;
      engineRef: string | null;
      modelRef: string | null;
      status: string;
      tokensInput: number;
      tokensOutput: number;
      latencyMs: number | null;
      error: string | null;
      errorClass: string | null;
      logRef: string | null;
    } | null = null;

    const spawnId = node.currentSpawnId;
    if (spawnId) {
      const spawnRows = await db
        .select({
          id: v3Schema.v3Spawns.id,
          agentName: v3Schema.v3Spawns.agentName,
          runtime: v3Schema.v3Spawns.runtime,
          engineRef: v3Schema.v3Spawns.engineRef,
          modelRef: v3Schema.v3Spawns.modelRef,
          status: v3Schema.v3Spawns.status,
          tokensInput: v3Schema.v3Spawns.tokensInput,
          tokensOutput: v3Schema.v3Spawns.tokensOutput,
          latencyMs: v3Schema.v3Spawns.latencyMs,
          error: v3Schema.v3Spawns.error,
          errorClass: v3Schema.v3Spawns.errorClass,
          logRef: v3Schema.v3Spawns.logRef,
        })
        .from(v3Schema.v3Spawns)
        .where(eq(v3Schema.v3Spawns.id, spawnId))
        .limit(1);

      if (spawnRows.length) {
        spawn = spawnRows[0];
      }
    }

    // Optional include: full_log
    let fullLog: string | null = null;
    if (args.include.includes("full_log") && spawn?.logRef) {
      const logArtRows = await db
        .select({ textContent: v3Schema.v3Artifacts.textContent })
        .from(v3Schema.v3Artifacts)
        .where(eq(v3Schema.v3Artifacts.id, spawn.logRef))
        .limit(1);

      fullLog = logArtRows[0]?.textContent ?? `[log ref: ${spawn.logRef}]`;
    }

    // Optional include: schema — read from DAG definition
    let outputSchema: unknown = null;
    if (args.include.includes("schema")) {
      const runRows = await db
        .select({ dag: v3Schema.v3Runs.dag })
        .from(v3Schema.v3Runs)
        .where(eq(v3Schema.v3Runs.id, args.runId))
        .limit(1);

      if (runRows.length) {
        const dag = runRows[0].dag as {
          nodes?: Array<{ id: string; output_schema?: unknown }>;
        } | null;
        const dagNode = (dag?.nodes ?? []).find((n) => n.id === node.nodeIdInDag);
        outputSchema = dagNode?.output_schema ?? null;
      }
    }

    // Optional include: full_diff — look for a workspace-diff artifact
    let fullDiff: string | null = null;
    if (args.include.includes("full_diff") && node.outputArtifactId) {
      // Look for sibling workspace-diff artifact associated with the same spawn
      if (spawnId) {
        const diffArtRows = await db
          .select({ textContent: v3Schema.v3Artifacts.textContent })
          .from(v3Schema.v3Artifacts)
          .where(
            and(
              eq(v3Schema.v3Artifacts.spawnId, spawnId),
              eq(v3Schema.v3Artifacts.kind, "workspace-diff"),
            ),
          )
          .limit(1);

        fullDiff = diffArtRows[0]?.textContent ?? null;
      }
    }

    return {
      nodeId: node.id,
      runId: node.runId,
      nodeIdInDag: node.nodeIdInDag,
      type: node.type,
      status: node.status,
      iteration: node.iteration,
      fanoutIndex: node.fanoutIndex,
      startedAt: node.startedAt?.toISOString() ?? null,
      completedAt: node.completedAt?.toISOString() ?? null,
      error: node.error ?? null,
      output,
      outputKind,
      truncated,
      spawn: spawn
        ? {
            id: spawn.id,
            agentName: spawn.agentName,
            runtime: spawn.runtime,
            engineRef: spawn.engineRef,
            modelRef: spawn.modelRef,
            status: spawn.status,
            tokensInput: spawn.tokensInput,
            tokensOutput: spawn.tokensOutput,
            latencyMs: spawn.latencyMs,
            error: spawn.error,
            errorClass: spawn.errorClass,
          }
        : null,
      ...(args.include.includes("full_log") ? { fullLog } : {}),
      ...(args.include.includes("schema") ? { outputSchema } : {}),
      ...(args.include.includes("full_diff") ? { fullDiff } : {}),
    };
  },
});
