import { defineAction } from "@agent-native/core";
import { z } from "zod";

import { getSpawnDefaultTimeoutSeconds } from "../server/orchestration-defaults.js";

export default defineAction({
  description:
    "Get the configured default timeout (seconds) for spawn.once ad-hoc " +
    "agent calls that don't specify their own timeoutSeconds.",
  schema: z.object({}),
  http: { method: "GET" },
  run: async () => {
    const seconds = await getSpawnDefaultTimeoutSeconds();
    return { seconds };
  },
});
