// set-claude-code-node-concurrency (R4a.3 §4.2 point 7). Set the claude-code
// WORKER-NODE concurrency degree — how many DAG-internal agent nodes
// resolving to the claude-code runtime (agent:'claude-code' or an
// engine_override pointing at it) run at once, globally across all runs.
// Persisted as a setting so it is tuned without code; the reconciler's
// admission gate reads it on the next dispatch attempt. Clamped to
// [MIN, MAX]. Lowering it does not kill a running node — the cap simply
// stops new admissions until running nodes drain below it.

import { defineAction } from "@agent-native/core";
import { z } from "zod";

import {
  setClaudeCodeNodeConcurrency,
  MIN_CLAUDE_CODE_NODE_CONCURRENCY,
  MAX_CLAUDE_CODE_NODE_CONCURRENCY,
} from "../server/queue/claude-code-concurrency.js";

export default defineAction({
  description:
    "Set the claude-code WORKER-NODE concurrency degree (how many DAG-internal " +
    "agent nodes resolving to the claude-code runtime run at once, globally " +
    "across all runs). Persisted; the reconciler's admission gate reads it on " +
    "the next dispatch attempt. Lowering it does not kill a running node — new " +
    "admissions simply stop until running nodes drain below the new cap. " +
    "Distinct from set-brain-concurrency, which caps brain threads.",
  schema: z.object({
    degree: z.coerce
      .number()
      .int()
      .min(MIN_CLAUDE_CODE_NODE_CONCURRENCY)
      .max(MAX_CLAUDE_CODE_NODE_CONCURRENCY)
      .describe(
        `Claude-code worker-node concurrency, ${MIN_CLAUDE_CODE_NODE_CONCURRENCY}..${MAX_CLAUDE_CODE_NODE_CONCURRENCY}`,
      ),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const stored = await setClaudeCodeNodeConcurrency(args.degree);
    return { claudeCodeNodeConcurrency: stored };
  },
});
