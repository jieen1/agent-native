import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { z } from "zod";
import { overrideNode } from "../server/engine/control.js";
import type { NodeConfigPatch } from "../server/engine/types.js";

// node-override (DESIGN §4.3): apply a prompt/model/engine/effort patch to a
// node and re-run it + its downstream; upstream reused. The patch is scoped to
// this run (never mutates the shared template).
const patchObject = z.object({
  prompt: z.string().optional(),
  model: z.string().optional(),
  engine: z.string().optional(),
  effort: z.enum(["low", "medium", "high"]).optional(),
});

export default defineAction({
  description:
    "Override a node's prompt/model/engine/effort for this run and re-run it + its downstream; upstream is reused.",
  schema: z.object({
    runId: z.string(),
    nodeRunId: z.string(),
    // Accept an object OR a JSON string (headless `--patch '{...}'` passes a
    // string), mirroring save-template's graph-union boundary tolerance.
    patch: z.union([patchObject, z.string()]),
    echoDelayMs: z.coerce.number().int().min(0).optional(),
  }),
  run: async (args) => {
    const access = await resolveAccess("workflow_run", args.runId);
    if (!access) throw new Error(`Run ${args.runId} not found`);
    if (access.role === "viewer") throw new Error("Read-only access");
    let patch: NodeConfigPatch;
    if (typeof args.patch === "string") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(args.patch);
      } catch {
        throw new Error("patch string is not valid JSON");
      }
      patch = patchObject.parse(parsed);
    } else {
      patch = args.patch;
    }
    if (Object.keys(patch).length === 0) {
      throw new Error(
        "patch must set at least one of prompt/model/engine/effort",
      );
    }
    const outcome = await overrideNode(args.runId, args.nodeRunId, patch, {
      echoDelayMs: args.echoDelayMs,
    });
    return {
      runId: args.runId,
      nodeRunId: args.nodeRunId,
      status: outcome.status,
      tokensSpent: outcome.tokensSpent,
    };
  },
});
