import { defineAction } from "@agent-native/core";
import { z } from "zod";

import { listRecentAliasChanges } from "../server/model-registry.js";

export default defineAction({
  description:
    "List recent model-registry alias-change events (04 §7 '别名漂移可见', " +
    "SDLC-054) and count how many fell within the trailing windowDays " +
    "(default 7). Backs the S9 model-registry card's alias-drift banner.",
  schema: z.object({
    windowDays: z.number().int().positive().max(90).default(7),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args) => {
    return listRecentAliasChanges(args.windowDays);
  },
});
