// V3 run.fork action (DESIGN §8.4, G4).
//
// Creates a new run forked from an existing one with artifact caching.
// Already-resolved nodes reuse their artifacts; fromNode and its transitive
// descendants are reset to pending so the reconciler re-executes them.
// After forking, the new run is immediately ticked.

import { defineAction } from "@agent-native/core";
import { z } from "zod";
import { getV3Db } from "../server/db/v3.js";
import { forkRun } from "../server/engine/v3-fork.js";
import { triggerTickSafe } from "../server/plugins/v3-reconciler.js";

/**
 * Fork a V3 run (DESIGN §8.4 "Patch the future, fork the past").
 *
 * Use when you need to change a node that is already running or done.
 * The fork reuses the source run's completed artifacts as cache and
 * re-executes only the fromNode and its transitive descendants.
 *
 * If fromNode is omitted the entire run is forked fresh (no cache).
 */
export const runFork = defineAction({
  description:
    "Fork a V3 run with artifact caching (DESIGN §8.4). " +
    "Use to change a node that is already running or done (behind the execution frontier). " +
    "Resolved nodes reuse their artifacts; fromNode and descendants are re-executed. " +
    "Returns the new runId.",
  schema: z.object({
    runId: z.string(),
    fromNode: z
      .string()
      .optional()
      .describe(
        "Node id (in DAG) to reset. This node and all transitive descendants " +
          "are re-executed. Omit to fork the entire run fresh (no cache).",
      ),
    overrideInputs: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Partial input overrides merged into the source run's inputs. " +
          "Pending nodes will pick up the new values when prompts are rendered.",
      ),
    extraTags: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Extra tags merged into the source run's tags. Keys in extraTags " +
          "overwrite matching source keys.",
      ),
  }),
  run: async (args) => {
    const db = getV3Db();

    const result = await forkRun(db as any, args.runId, {
      fromNode: args.fromNode,
      overrideInputs: args.overrideInputs,
      extraTags: args.extraTags,
    });

    // G1: Kick the reconciler so the new run starts immediately.
    triggerTickSafe(result.runId).catch(() => {});

    return {
      runId: result.runId,
      ok: true,
    };
  },
});
