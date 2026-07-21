import { defineAction } from "@agent-native/core";
import { z } from "zod";

import { disconnectManagedLogin } from "../server/claude-login.js";

// Log the container out of its managed Claude Code subscription login by
// deleting the credential from the isolated managed config dir. Only touches
// the container's own login — never the host's ~/.claude.
export default defineAction({
  description:
    "Disconnect (log out) the container's own managed Claude Code login by " +
    "deleting its credential from the isolated managed config dir. Does not " +
    "affect the host's ~/.claude. Returns { ok: true }.",
  schema: z.object({}),
  run: async () => {
    disconnectManagedLogin();
    return { ok: true as const };
  },
});
