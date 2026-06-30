import { defineAction } from "@agent-native/core";
import { z } from "zod";
import { startLogin } from "../server/claude-login.js";

// Start a managed Claude Code SUBSCRIPTION login for the container (OAuth 2.0
// Authorization Code + PKCE). Returns a sessionId plus the authorize URL the
// END USER opens in their browser. The user authorizes, copies the code the
// callback shows, and submits it via `claudeConnectComplete` with this same
// sessionId. The PKCE verifier/state are held in memory only — never sent to
// the client and never written to disk until the code is exchanged.
export default defineAction({
  description:
    "Start the container's managed Claude Code subscription login. Returns a " +
    "sessionId and an authUrl (claude.com OAuth). The user opens authUrl, " +
    "approves, copies the shown code, then calls claudeConnectComplete with the " +
    "same sessionId and that code. Does not touch the host's ~/.claude.",
  schema: z.object({}),
  // Login start mutates server-side session state but writes no app data; keep
  // it a POST (default) so it isn't treated as a cacheable read.
  run: async () => {
    const { sessionId, authUrl } = startLogin();
    return { sessionId, authUrl };
  },
});
