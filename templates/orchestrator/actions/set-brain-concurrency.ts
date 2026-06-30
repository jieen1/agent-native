// set-brain-concurrency (LEVEL-1). Set the brain-task concurrency degree — how
// many orchestrator brain tasks (each a headless `claude -p` brain in its own
// worktree) run at once. Persisted as a setting so it is tuned without code; the
// admission gate + durable driver read it on the next tick, so the cap changes
// on the next admit/release. Clamped to [MIN, MAX]. After lowering the degree no
// running task is killed — the cap simply stops new admissions until running
// tasks drain below it; after raising it, admission immediately pulls queued
// tasks into the new slots.

import { defineAction } from "@agent-native/core";
import { z } from "zod";
import {
  setBrainConcurrency,
  MIN_BRAIN_CONCURRENCY,
  MAX_BRAIN_CONCURRENCY,
} from "../server/queue/brain-concurrency.js";
import { admitBrainTasks } from "../server/queue/brain-admit.js";

export default defineAction({
  description:
    "Set the orchestrator BRAIN-task concurrency degree (how many brain tasks run " +
    "at once — each a headless brain in its own git worktree). Persisted; the " +
    "admission gate reads it on the next tick. Raising it immediately admits " +
    "queued tasks into the new slots; lowering it stops new admissions until " +
    "running tasks drain (no running task is killed).",
  schema: z.object({
    degree: z.coerce
      .number()
      .int()
      .min(MIN_BRAIN_CONCURRENCY)
      .max(MAX_BRAIN_CONCURRENCY)
      .describe(
        `Brain-task concurrency, ${MIN_BRAIN_CONCURRENCY}..${MAX_BRAIN_CONCURRENCY}`,
      ),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const stored = await setBrainConcurrency(args.degree);
    // Raising the degree should pull queued tasks into the new slots right away
    // rather than waiting for the next driver tick.
    const promoted = await admitBrainTasks().catch(() => [] as string[]);
    return { brainConcurrency: stored, promoted: promoted.length };
  },
});
