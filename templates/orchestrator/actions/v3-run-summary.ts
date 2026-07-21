/**
 * run.summary — on-demand roll-up of a V3 run (design §8.4, §11, §14).
 *
 * Never auto-computed. Only produced when CC explicitly calls this action.
 * Aggregates node statuses, total tokens, and the last output from each
 * terminal node. Does NOT cross spawn contexts or summarize via LLM.
 *
 * G21: new action file for missing run.summary tool.
 */

import { defineAction } from "@agent-native/core";
import { eq, and, sql, inArray, isNotNull, desc } from "drizzle-orm";
import { z } from "zod";

import { getV3Db, v3Schema, resolveOwnerEmail } from "../server/db/index.js";
import { localWorkspaceDiffStats } from "../server/v3-workspace-local.js";
import { DiffBaseUnresolvableError } from "../server/v3-workspace-provision.js";

export const runSummary = defineAction({
  description:
    "On-demand roll-up of a V3 run. Returns run metadata, node status counts, " +
    "total token usage, and a summary of each terminal node's output. " +
    "Not auto-computed — call explicitly when you need the current roll-up (design §8.4).",
  schema: z.object({
    runId: z.string().min(1),
  }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    const db = getV3Db();

    // Load run row — fail-closed owner scope prevents cross-tenant reads.
    const runFilter = and(
      eq(v3Schema.v3Runs.id, args.runId),
      eq(v3Schema.v3Runs.ownerEmail, resolveOwnerEmail()),
    );
    const runRows = await db
      .select({
        id: v3Schema.v3Runs.id,
        templateId: v3Schema.v3Runs.templateId,
        templateVersion: v3Schema.v3Runs.templateVersion,
        status: v3Schema.v3Runs.status,
        priority: v3Schema.v3Runs.priority,
        tags: v3Schema.v3Runs.tags,
        dagVersion: v3Schema.v3Runs.dagVersion,
        startedAt: v3Schema.v3Runs.startedAt,
        completedAt: v3Schema.v3Runs.completedAt,
      })
      .from(v3Schema.v3Runs)
      .where(runFilter)
      .limit(1);

    if (!runRows.length) throw new Error(`Run '${args.runId}' not found`);
    const run = runRows[0];

    // Node status counts
    const nodeCountRows = await db
      .select({
        status: v3Schema.v3Nodes.status,
        count: sql<number>`count(*)`.mapWith(Number),
      })
      .from(v3Schema.v3Nodes)
      .where(eq(v3Schema.v3Nodes.runId, args.runId))
      .groupBy(v3Schema.v3Nodes.status);

    const nodeCounts: Record<string, number> = {};
    let totalNodes = 0;
    for (const row of nodeCountRows) {
      nodeCounts[row.status] = row.count;
      totalNodes += row.count;
    }

    // Terminal node outputs (done + failed + skipped)
    const terminalNodes = await db
      .select({
        id: v3Schema.v3Nodes.id,
        nodeIdInDag: v3Schema.v3Nodes.nodeIdInDag,
        type: v3Schema.v3Nodes.type,
        status: v3Schema.v3Nodes.status,
        iteration: v3Schema.v3Nodes.iteration,
        fanoutIndex: v3Schema.v3Nodes.fanoutIndex,
        outputArtifactId: v3Schema.v3Nodes.outputArtifactId,
        error: v3Schema.v3Nodes.error,
        completedAt: v3Schema.v3Nodes.completedAt,
      })
      .from(v3Schema.v3Nodes)
      .where(
        and(
          eq(v3Schema.v3Nodes.runId, args.runId),
          sql`${v3Schema.v3Nodes.status} IN ('done', 'failed', 'skipped')`,
        ),
      );

    // Collect artifact ids to batch-fetch
    const artifactIds = terminalNodes
      .map((n) => n.outputArtifactId)
      .filter(Boolean) as string[];

    const artifactMap = new Map<string, string | null>();
    if (artifactIds.length > 0) {
      const artRows = await db
        .select({
          id: v3Schema.v3Artifacts.id,
          textContent: v3Schema.v3Artifacts.textContent,
          objectContent: v3Schema.v3Artifacts.objectContent,
        })
        .from(v3Schema.v3Artifacts)
        .where(inArray(v3Schema.v3Artifacts.id, artifactIds));

      for (const art of artRows) {
        const content =
          art.textContent ??
          (art.objectContent != null
            ? JSON.stringify(art.objectContent)
            : null);
        artifactMap.set(art.id, content);
      }
    }

    // Aggregate token usage from spawns associated with this run's nodes
    const tokenRows = await db
      .select({
        totalInput:
          sql<number>`coalesce(sum(${v3Schema.v3Spawns.tokensInput}), 0)`.mapWith(
            Number,
          ),
        totalOutput:
          sql<number>`coalesce(sum(${v3Schema.v3Spawns.tokensOutput}), 0)`.mapWith(
            Number,
          ),
        spawnCount: sql<number>`count(${v3Schema.v3Spawns.id})`.mapWith(Number),
      })
      .from(v3Schema.v3Nodes)
      .leftJoin(
        v3Schema.v3Spawns,
        eq(v3Schema.v3Spawns.nodeId, v3Schema.v3Nodes.id),
      )
      .where(eq(v3Schema.v3Nodes.runId, args.runId));

    const tokens = tokenRows[0] ?? {
      totalInput: 0,
      totalOutput: 0,
      spawnCount: 0,
    };

    // W4 (SDLC-059) — diff stats, the SECOND call site resolveDiffBase must
    // cover (workspaceDiff is the first). Resolve the most recently-started
    // spawn on this run that carries a workspaceId, and compute aggregate
    // diff counts (not full patch text — this is a roll-up, not a diff view).
    // Never auto-runs anything else; a resolution failure returns an explicit
    // error shape, NEVER a diff computed against a guessed/stale base.
    const wsRows = await db
      .select({ workspaceId: v3Schema.v3Spawns.workspaceId })
      .from(v3Schema.v3Spawns)
      .innerJoin(
        v3Schema.v3Nodes,
        eq(v3Schema.v3Spawns.nodeId, v3Schema.v3Nodes.id),
      )
      .where(
        and(
          eq(v3Schema.v3Nodes.runId, args.runId),
          isNotNull(v3Schema.v3Spawns.workspaceId),
        ),
      )
      .orderBy(desc(v3Schema.v3Spawns.startedAt))
      .limit(1);

    const workspaceId = wsRows[0]?.workspaceId ?? null;
    let diff:
      | {
          base: string;
          baseSource: string;
          filesChanged: number;
          additions: number;
          deletions: number;
        }
      | { error: "diff-base-unresolvable"; detail: string }
      | null = null;
    if (workspaceId) {
      try {
        const stats = await localWorkspaceDiffStats(workspaceId);
        diff = stats
          ? {
              base: stats.base,
              baseSource: stats.baseSource,
              filesChanged: stats.filesChanged,
              additions: stats.additions,
              deletions: stats.deletions,
            }
          : null;
      } catch (err) {
        if (err instanceof DiffBaseUnresolvableError) {
          diff = { error: "diff-base-unresolvable", detail: err.message };
        } else {
          throw err;
        }
      }
    }

    const nodeOutputs = terminalNodes.map((n) => ({
      nodeId: n.id,
      nodeIdInDag: n.nodeIdInDag,
      type: n.type,
      status: n.status,
      iteration: n.iteration,
      fanoutIndex: n.fanoutIndex,
      error: n.error ?? null,
      completedAt: n.completedAt?.toISOString() ?? null,
      output: n.outputArtifactId
        ? (artifactMap.get(n.outputArtifactId) ?? null)
        : null,
    }));

    const doneCount = nodeCounts["done"] ?? 0;
    const failedCount = nodeCounts["failed"] ?? 0;
    const skippedCount = nodeCounts["skipped"] ?? 0;
    const runningCount = nodeCounts["running"] ?? 0;
    const pendingCount = nodeCounts["pending"] ?? 0;

    return {
      runId: run.id,
      status: run.status,
      templateId: run.templateId,
      templateVersion: run.templateVersion,
      priority: run.priority,
      tags: run.tags,
      dagVersion: run.dagVersion,
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
      nodes: {
        total: totalNodes,
        done: doneCount,
        failed: failedCount,
        skipped: skippedCount,
        running: runningCount,
        pending: pendingCount,
        awaitingApproval: nodeCounts["awaiting-approval"] ?? 0,
        ready: nodeCounts["ready"] ?? 0,
      },
      tokens: {
        input: tokens.totalInput,
        output: tokens.totalOutput,
        total: tokens.totalInput + tokens.totalOutput,
        spawnCount: tokens.spawnCount,
      },
      /** Terminal node outputs, one entry per done/failed/skipped node. */
      nodeOutputs,
      /**
       * Diff stats for the run's workspace (W4) — null when no spawn on this
       * run carries a workspaceId; `{error:"diff-base-unresolvable",detail}`
       * when the base couldn't be resolved (never a stat computed against a
       * guessed/stale base).
       */
      diff,
    };
  },
});
