import { defineAction } from "@agent-native/core";
import { z } from "zod";

export default defineAction({
  description: "Health-check ping action. Returns ok status, the current ISO timestamp, and the app name.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => ({ ok: true, ts: new Date().toISOString(), app: "analytics" }),
});
