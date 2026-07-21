// set-brain-model-tier — configure which model tier is permitted for the CC
// subscription brain. "sonnet" (default) blocks Opus; "all" allows everything.
// If the currently-saved brain model is blocked by the new tier, the override
// is cleared so the brain falls back to the CLI default (Sonnet).

import { defineAction } from "@agent-native/core";
import { putSetting } from "@agent-native/core/settings";
import { z } from "zod";

import {
  setBrainModelTier,
  getBrainModel,
  isModelAllowedInTier,
  BRAIN_MODEL_KEY,
} from "../server/brain/brain-model.js";
import type { BrainModelTier } from "../server/brain/brain-model.js";

export default defineAction({
  description:
    "Set the CC subscription brain model tier. 'sonnet' (default) restricts " +
    "the brain to Sonnet and Haiku models only — Opus is blocked. 'all' " +
    "permits the full accepted model list including Opus. If the currently " +
    "configured brain model is blocked by the new tier it is automatically " +
    "cleared (brain falls back to the CLI default).",
  schema: z.object({
    tier: z
      .enum(["sonnet", "all"])
      .describe("'sonnet' = Sonnet/Haiku only; 'all' = full list inc. Opus"),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const tier = args.tier as BrainModelTier;
    await setBrainModelTier(tier);

    // If the currently saved brain model is now blocked, clear it.
    let clearedModel: string | null = null;
    const currentModel = await getBrainModel();
    if (currentModel && !isModelAllowedInTier(currentModel, tier)) {
      await putSetting(BRAIN_MODEL_KEY, { model: "" });
      clearedModel = currentModel;
    }

    return { tier, clearedModel };
  },
});
