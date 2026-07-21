// get-brain-model-tier — returns the current CC subscription model tier and
// the list of model ids/aliases allowed under it. Used by the Settings page
// and the brain model selector to filter which models are selectable.

import { defineAction } from "@agent-native/core";
import { z } from "zod";

import {
  getBrainModelTier,
  getAllowedBrainModels,
  BRAIN_MODEL_LABELS,
} from "../server/brain/brain-model.js";

export default defineAction({
  description:
    "Return the current CC subscription model tier ('sonnet' or 'all') and " +
    "the list of brain model ids allowed under it. When tier is 'sonnet' " +
    "Opus models are blocked; 'all' permits the full accepted list.",
  schema: z.object({}),
  http: { method: "GET" },
  run: async () => {
    const tier = await getBrainModelTier();
    const allowed = getAllowedBrainModels(tier);
    return {
      tier,
      allowedModels: allowed.map((id) => ({
        id,
        label: BRAIN_MODEL_LABELS[id] ?? id,
      })),
    };
  },
});
