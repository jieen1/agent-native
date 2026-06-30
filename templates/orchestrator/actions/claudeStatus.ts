import { defineAction } from "@agent-native/core";
import { z } from "zod";
import { getManagedClaudeStatus } from "../server/claude-managed-auth.js";
import { hasManagedCredentials } from "../server/claude-login.js";

// Report the container's OWN managed Claude Code subscription login status
// (the isolated config dir — never the host's ~/.claude). Never exposes the
// token itself, only presence / expiry / subscription tier.
export default defineAction({
  description:
    "Get the orchestrator container's own managed Claude Code login status " +
    "(subscription OAuth in its isolated config dir, separate from the host). " +
    "Returns loggedIn, expired, subscriptionType, expiresAt, and connected.",
  schema: z.object({}),
  readOnly: true,
  http: { method: "GET" },
  run: async () => {
    const status = getManagedClaudeStatus();
    return {
      loggedIn: status.loggedIn,
      expired: status.expired,
      subscriptionType: status.subscriptionType,
      expiresAt: status.expiresAt,
      // `connected` = a credential exists at all (even if expired — a refresh
      // can revive it); `loggedIn` additionally requires it to be unexpired.
      connected: hasManagedCredentials(),
    };
  },
});
