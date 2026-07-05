/**
 * spawn.once — ad-hoc spawn (design §8.1).
 *
 * Creates a minimal single-agent workflow run under the hood so the V3
 * reconciler can dispatch it immediately. Returns a runId the caller can
 * poll via runState / v3RunEvents, plus a synthetic spawnId for compatibility.
 *
 * Previous implementation only inserted a v3_spawns row (node_id=NULL) which
 * the orphan-reconciler later cancelled — the dispatch was never wired. This
 * implementation creates a real run so the reconciler picks it up.
 */

import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { z } from "zod";
import { getV3Db, v3Schema } from "../server/db/index.js";
import { newId } from "./_util.js";
import { triggerTickSafe } from "../server/plugins/v3-reconciler.js";

export const spawnOnce = defineAction({
  description:
    "Ad-hoc spawn: dispatch a single agent invocation outside of any named workflow. " +
    "Creates a minimal single-node run that the V3 reconciler dispatches immediately. " +
    "Poll runState with the returned runId to track completion. " +
    "Accepts optional tags for cross-app traceability (design §16).",
  schema: z.object({
    /** Agent name (matches .claude/agents/<name>.md). */
    agent: z.string().min(1),
    /** The full prompt string — no {{ }} interpolation for ad-hoc spawns. */
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
  }),
  run: async (args) => {
    const db = getV3Db();
    const ownerEmail = getRequestUserEmail() ?? "local@localhost";
    const orgId = getRequestOrgId() ?? null;

    const nodeId = "spawn_agent";
    const dag = {
      nodes: [
        {
          id: nodeId,
          type: "agent" as const,
          agent: args.agent,
          prompt: args.prompt,
          ...(args.engineOverride ? { engine_override: args.engineOverride } : {}),
          ...(args.modelOverride ? { model_override: args.modelOverride } : {}),
          ...(args.workspace ? { workspace: args.workspace } : {}),
          ...(args.outputSchema ? { output_schema: args.outputSchema } : {}),
          ...(args.maxSummaryTokens !== 2000 ? { max_summary_tokens: args.maxSummaryTokens } : {}),
          ...(args.timeoutSeconds !== 120 ? { timeout_seconds: args.timeoutSeconds } : {}),
          ...(args.retry ? { retry: args.retry } : {}),
          deps: [],
        },
      ],
    };

    const runId = newId("v3r");

    await db.insert(v3Schema.v3Runs).values({
      id: runId,
      templateId: null,
      templateVersion: null,
      inputs: null,
      dag,
      dagVersion: 1,
      status: "pending",
      priority: 0,
      tags: args.tags ? (args.tags as any) : null,
      ownerEmail,
      orgId,
    });

    const nodeRowId = newId("v3n");
    await db.insert(v3Schema.v3Nodes).values({
      id: nodeRowId,
      runId,
      nodeIdInDag: nodeId,
      type: "agent",
      status: "pending",
      iteration: 0,
      fanoutIndex: 0,
      ownerEmail,
      orgId,
    });

    // Trigger reconciler immediately so the node advances without waiting for
    // the next periodic tick.
    triggerTickSafe(runId).catch(() => {});

    return {
      runId,
      nodeRowId,
      status: "pending",
      agent: args.agent,
      note: "Spawned as a single-node run. Poll runState with runId for completion.",
    };
  },
});
