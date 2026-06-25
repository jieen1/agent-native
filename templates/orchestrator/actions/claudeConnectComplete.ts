import { defineAction } from "@agent-native/core";
import { z } from "zod";
import { completeLogin } from "../server/claude-login.js";

// Finish the managed Claude Code subscription login: exchange the pasted
// authorization code (PKCE) for tokens and write the credential into the
// container's isolated managed config dir. Pass the sessionId returned by
// `claudeConnect` and the code the OAuth callback displayed. The callback may
// show the code as `code#state`; either form is accepted.
export default defineAction({
  description:
    "Complete the container's managed Claude Code subscription login by " +
    "exchanging the authorization code from the OAuth callback. Provide the " +
    "sessionId from claudeConnect and the code shown after approval. Writes the " +
    "credential to the container's isolated config dir. Returns { loggedIn, error? }.",
  schema: z.object({
    sessionId: z.string().describe("The sessionId returned by claudeConnect."),
    code: z
      .string()
      .describe("The authorization code shown by the OAuth callback (may be `code#state`)."),
  }),
  run: async ({ sessionId, code }) => {
    return await completeLogin(sessionId, code);
  },
});
