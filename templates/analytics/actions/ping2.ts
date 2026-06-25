import { defineAction } from "@agent-native/core";
import { z } from "zod";

export default defineAction({
  // Read-only liveness probe: safe to call from run-code `appAction` and
  // reusable across continuation retries (no side effects).
  readOnly: true,
  description:
    "Health-check ping that returns the current server epoch timestamp in milliseconds.",
  schema: z.object({}),
  http: { method: "GET" },
  run: async () => {
    return { ok: true, ts: Date.now() };
  },
});
