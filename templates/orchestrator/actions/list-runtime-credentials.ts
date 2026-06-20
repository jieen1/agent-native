import { defineAction } from "@agent-native/core";
import { z } from "zod";
import {
  listRuntimeCredentials,
  CREDENTIALS_NOTE,
} from "../server/runtime/credentials.js";

// list-runtime-credentials (DESIGN §7.4.7, FRONTEND §9). Reports which secret
// KEYS the runtime mounts and whether each is registered (present) + which
// runtime/node kind injects it — reusing the framework secret surface. It
// NEVER decrypts or returns a secret VALUE; only a boolean presence flag.
export default defineAction({
  description:
    "List which credential keys the runtime mounts, whether each is registered, and which node kind injects it. Never returns a secret value.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
    const credentials = await listRuntimeCredentials();
    return { credentials, note: CREDENTIALS_NOTE };
  },
});
