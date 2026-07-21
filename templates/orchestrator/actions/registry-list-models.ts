import { defineAction } from "@agent-native/core";
import { z } from "zod";

import { listModels } from "../server/model-registry.js";

export default defineAction({
  description:
    "List registered models (real weight name + alias + tier + endpoint) — " +
    "the model identity single source of truth spawns/threads attribute " +
    "telemetry against (04 §7). Backs the S9 model registry table.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
    return listModels();
  },
});
