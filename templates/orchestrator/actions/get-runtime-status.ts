import { defineAction } from "@agent-native/core";
import { getSetting } from "@agent-native/core/settings";
import { z } from "zod";
import { getClaudeCodeAuthStatus } from "../server/claude-code-status.js";

const dynamicImport = new Function("s", "return import(s)") as (
  s: string,
) => Promise<unknown>;

async function harnessPackageInstalled(): Promise<boolean> {
  try {
    await dynamicImport("@ai-sdk/harness-claude-code");
    return true;
  } catch {
    return false;
  }
}

// Reports the active runtime + whether the Claude Code harness package is
// installed, so the Settings UI can guide setup.
export default defineAction({
  description:
    "Get the active model runtime and whether the Claude Code harness is installed.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
    const engine = (await getSetting("agent-engine").catch(() => null)) as
      | { engine?: string; model?: string; config?: { baseUrl?: string } }
      | null;
    const execRuntime = (await getSetting("orchestrator-runtime").catch(
      () => null,
    )) as { runtime?: string } | null;

    const auth = getClaudeCodeAuthStatus();
    return {
      chatEngine: engine?.engine ?? null,
      chatModel: engine?.model ?? null,
      chatBaseUrl: engine?.config?.baseUrl ?? null,
      executionRuntime: execRuntime?.runtime ?? "local",
      claudeCodeInstalled: await harnessPackageInstalled(),
      claudeCodeLoggedIn: auth.loggedIn,
      claudeCodeExpired: auth.expired,
      claudeCodeExpiresAt: auth.expiresAt,
      claudeCodeSubscription: auth.subscriptionType,
      claudeCodeCredentialsFound: auth.credentialsFound,
    };
  },
});
