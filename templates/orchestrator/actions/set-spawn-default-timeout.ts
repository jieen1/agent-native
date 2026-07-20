import { defineAction } from "@agent-native/core";
import { z } from "zod";

import { setSpawnDefaultTimeoutSeconds } from "../server/orchestration-defaults.js";

export default defineAction({
  description:
    "Set the configured default timeout (seconds) for spawn.once ad-hoc " +
    "agent calls that don't specify their own timeoutSeconds. Real-browser " +
    "screenshot/investigation spawns can legitimately take much longer than " +
    "a plain code-edit turn, so this is worth raising rather than baking a " +
    "fixed value into source.",
  schema: z.object({
    seconds: z
      .number()
      .int()
      .positive()
      .describe("New default timeout in seconds, e.g. 3600"),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const seconds = await setSpawnDefaultTimeoutSeconds(args.seconds);
    return { seconds };
  },
});
