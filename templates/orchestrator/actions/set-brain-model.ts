// set-brain-model — set the model the orchestrator BRAIN runs as. Persisted as
// a global setting; startBrainTurn threads `--model <id>` into the brain child's
// `claude` argv on the NEXT turn (the init `system` event then echoes the
// resolved id back into the panel). Validated against the accepted-id list so a
// typo can't wedge every brain turn with an "unknown model" failure. Pass an
// empty string to clear the override (fall back to DEFAULT_BRAIN_MODEL,
// Sonnet 5 1M).

import { defineAction } from "@agent-native/core";
import { z } from "zod";
import {
  setBrainModel,
  getBrainModel,
  ACCEPTED_BRAIN_MODELS,
  isAcceptedBrainModel,
  getBrainModelTier,
  isModelAllowedInTier,
} from "../server/brain/brain-model.js";
import { putSetting } from "@agent-native/core/settings";
import { BRAIN_MODEL_KEY } from "../server/brain/brain-model.js";

export default defineAction({
  description:
    "Set the model the orchestrator BRAIN's headless `claude -p` child runs as " +
    "(threaded as `--model <id>` on the next brain turn). Persisted as a global " +
    "setting; the init `system` event echoes the resolved id back to the usage " +
    "panel. Validated against the accepted ids. Pass an empty model to clear " +
    "the override (fall back to the default, Sonnet 5 1M).",
  schema: z.object({
    model: z
      .string()
      .describe(
        `One of: ${ACCEPTED_BRAIN_MODELS.join(", ")}. Empty string clears the override.`,
      ),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const trimmed = args.model.trim();
    // Empty / "default" → clear the override (falls back to Sonnet 5 1M).
    if (trimmed === "" || trimmed === "default") {
      await putSetting(BRAIN_MODEL_KEY, { model: "" });
      return { brainModel: null, cleared: true };
    }
    if (!isAcceptedBrainModel(trimmed)) {
      throw new Error(
        `Unsupported brain model '${trimmed}'. Accepted: ${ACCEPTED_BRAIN_MODELS.join(", ")}`,
      );
    }
    const tier = await getBrainModelTier();
    if (!isModelAllowedInTier(trimmed, tier)) {
      throw new Error(
        `Model '${trimmed}' is blocked by the current subscription tier (${tier}). ` +
          "Premium models (Opus/Fable) are not permitted when the tier is 'sonnet'. " +
          "Update the brain model tier in Settings → Claude Code to allow them.",
      );
    }
    const stored = await setBrainModel(trimmed);
    const current = await getBrainModel();
    return { brainModel: stored, current, cleared: false };
  },
});
