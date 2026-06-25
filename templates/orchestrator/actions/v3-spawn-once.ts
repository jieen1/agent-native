/**
 * spawn.once — ad-hoc spawn (design §8.1).
 *
 * Inserts a v3_spawns row with node_id NULL (ad-hoc, not run-scoped).
 * The actual worker dispatch is deferred to the reconciler / dispatcher;
 * this action records the intent and returns the spawnId so the caller
 * can poll via spawn.get.
 *
 * G21: new action file for missing spawn.once tool.
 */

import { defineAction } from "@agent-native/core";
import { z } from "zod";
import { getV3Db, v3Schema } from "../server/db/v3.js";
import { newId } from "./_util.js";

export const spawnOnce = defineAction({
  description:
    "Ad-hoc spawn: dispatch a single agent invocation outside of any workflow run. " +
    "Inserts a v3_spawns row with node_id NULL and returns spawnId. " +
    "Poll via spawn.get to check completion. " +
    "Accepts optional tags for cross-app traceability (design §16).",
  schema: z.object({
    /** Agent name (matches .claude/agents/<name>.md). */
    agent: z.string().min(1),
    /** The full prompt string — no {{ }} interpolation (no DAG context for ad-hoc spawns). */
    prompt: z.string().min(1),
    /** Override the agent's declared engine. */
    engineOverride: z.string().optional(),
    /** Override the agent's declared model. */
    modelOverride: z.string().optional(),
    /** Override the agent's runtime. */
    runtimeOverride: z.string().optional(),
    /** Workspace id to mount at /work. */
    workspace: z.string().optional(),
    /** JSON Schema for structured output (opt-in). */
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    /** Max tokens for the summary / output (default: 2000). */
    maxSummaryTokens: z.number().int().positive().default(2000),
    /** Timeout in seconds for the spawn (default: 120). */
    timeoutSeconds: z.number().int().positive().default(120),
    /** Retry policy. */
    retry: z
      .object({
        max: z.number().int().min(0).default(1),
        on: z.array(z.string()).default(["transient"]),
      })
      .optional(),
    /**
     * Opaque tags for cross-app traceability (design §16).
     * E.g. { source: "tracker", item_id: "PAY-14" }.
     */
    tags: z.record(z.string(), z.string()).optional(),
    /**
     * If true, return immediately with { spawnId } without waiting for completion.
     * Poll spawn.get for the result. Default: false (synchronous, best-effort).
     */
    async: z.boolean().default(false),
  }),
  run: async (args) => {
    const db = getV3Db();

    const spawnId = newId("sp");

    await db.insert(v3Schema.v3Spawns).values({
      id: spawnId,
      nodeId: null,       // ad-hoc — no node association
      attempt: 1,
      agentName: args.agent,
      engineRef: args.engineOverride ?? null,
      modelRef: args.modelOverride ?? null,
      runtime: args.runtimeOverride ?? "microvm",
      workspaceId: args.workspace ?? null,
      renderedPrompt: args.prompt,
      status: "pending",
      tags: args.tags ? (args.tags as any) : null,
      startedAt: new Date(),
    });

    // Note: actual worker dispatch is not yet wired to a live microVM/ACP executor
    // in this environment. The spawn row is created with status=pending so the
    // reconciler / external dispatcher can pick it up. When the full dispatcher is
    // wired, it will transition the status to running → done/failed.

    return {
      spawnId,
      status: "pending",
      agent: args.agent,
      async: args.async,
      note: "Spawn enqueued. Poll spawn.get for completion. Full microVM/ACP dispatch requires the runtime pool to be configured.",
    };
  },
});
