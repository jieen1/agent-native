// get-claude-code-node-concurrency (R4a.3 §4.2 point 7). Read the current
// claude-code WORKER-NODE concurrency degree — how many DAG-internal agent
// nodes resolving to the claude-code runtime run at once, globally, across
// all runs. A different dimension from get-brain-concurrency (brain
// threads). Read-only; the admission gate uses the same value.

import { defineAction } from "@agent-native/core";
import { z } from "zod";

import { getClaudeCodeNodeConcurrency } from "../server/queue/claude-code-concurrency.js";

export default defineAction({
  description:
    "Return the current claude-code WORKER-NODE concurrency degree (how many " +
    "DAG-internal agent nodes resolving to the claude-code runtime — via " +
    "agent:'claude-code' or an engine_override pointing at it — run at once, " +
    "globally across all runs). Read-only. Distinct from " +
    "get-brain-concurrency, which caps brain threads.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
    const claudeCodeNodeConcurrency = await getClaudeCodeNodeConcurrency();
    return { claudeCodeNodeConcurrency };
  },
});
