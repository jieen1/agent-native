import { defineAction } from "@agent-native/core";
import { z } from "zod";

import { upsertModel } from "../server/model-registry.js";

export default defineAction({
  description:
    "Register or update a model's alias -> real-weight-name mapping in the " +
    "model registry (04 §7, the single source of truth spawns/threads use to " +
    "attribute telemetry). Rejects a `claude-*` alias unless isClaudeWeight " +
    "is true (SDLC-054 fake-name guard) — the call fails with a structured " +
    "`alias-forbidden` error and writes nothing. Re-registering an existing " +
    "alias against a different realName is 'alias drift' and is recorded as " +
    "a registry.alias-changed event so it is visible on the S9 timeline.",
  schema: z.object({
    realName: z.string().min(1),
    alias: z.string().min(1),
    tier: z.string().optional(),
    endpoint: z.string().optional(),
    isClaudeWeight: z.boolean(),
  }),
  run: async (args) => {
    return upsertModel(args);
  },
});
