import { defineAction } from "@agent-native/core";
import { z } from "zod";

export default defineAction({
  // Read-only liveness probe: safe to call from run-code `appAction` and
  // reusable across continuation retries (no side effects).
  readOnly: true,
  description:
    "Health check for the analytics app. Returns a static status payload with the current server timestamp.",
  schema: z.object({}),
  http: { method: "GET" },
  run: async () => {
    return {
      status: "ok" as const,
      service: "analytics" as const,
      ts: new Date().toISOString(),
    };
  },
});
