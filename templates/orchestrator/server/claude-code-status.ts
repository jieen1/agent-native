import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Inspects the local `claude` CLI login (the harness reuses it = the user's
// subscription). Reports status WITHOUT ever exposing the token. The app cannot
// perform `claude login` itself (that is the CLI's browser OAuth flow on the
// user's machine) — it can only detect + guide.
export interface ClaudeCodeAuthStatus {
  credentialsFound: boolean;
  loggedIn: boolean; // credentials present AND not expired
  expired: boolean;
  expiresAt: string | null;
  subscriptionType: string | null;
}

export function getClaudeCodeAuthStatus(): ClaudeCodeAuthStatus {
  const empty: ClaudeCodeAuthStatus = {
    credentialsFound: false,
    loggedIn: false,
    expired: false,
    expiresAt: null,
    subscriptionType: null,
  };
  try {
    const path = join(homedir(), ".claude", ".credentials.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const o = (raw.claudeAiOauth ?? raw.oauth ?? raw) as Record<string, unknown>;
    const expRaw = (o.expiresAt ?? o.expires_at) as number | string | undefined;
    const expMs =
      typeof expRaw === "number"
        ? expRaw
        : typeof expRaw === "string"
          ? Date.parse(expRaw)
          : null;
    const expired = expMs != null ? expMs < Date.now() : false;
    const hasToken = !!(o.accessToken ?? o.access_token);
    return {
      credentialsFound: true,
      loggedIn: hasToken && !expired,
      expired,
      expiresAt: expMs != null ? new Date(expMs).toISOString() : null,
      subscriptionType:
        (o.subscriptionType as string | undefined) ??
        (o.subscription_type as string | undefined) ??
        null,
    };
  } catch {
    return empty;
  }
}
