import { readFileSync } from "node:fs";

// Container-owned Claude Code credential (DESIGN §13: "NO ~/.claude copying").
//
// orca-aligned model: the orchestrator container performs its OWN `claude auth
// login` into an ISOLATED config dir — a Docker volume separate from the host's
// ~/.claude — and manages it independently. Sharing one OAuth credential across
// host + container gets it revoked (refresh tokens are single-use; concurrent
// use rotates and invalidates), so the container holds its own independent
// login. The token is NEVER copied, mounted, or shared from the host.
//
// This intentionally supersedes the host-reading `claude-code-status.ts`: that
// module assumed the app could only detect the host login, never perform one.

/** The isolated config dir holding the container's OWN Claude Code login. */
export function managedClaudeConfigDir(): string {
  return process.env.ORCH_CLAUDE_CONFIG_DIR?.trim() || "/root/.claude-managed";
}

export interface ManagedClaudeStatus {
  /** The isolated dir the container's login lives in. */
  configDir: string;
  credentialsFound: boolean;
  /** credentials present AND not expired. */
  loggedIn: boolean;
  expired: boolean;
  expiresAt: string | null;
  subscriptionType: string | null;
}

/**
 * Read the container's own Claude Code login status from the managed config dir.
 * Never exposes the token itself — only presence / expiry / subscription tier.
 */
export function getManagedClaudeStatus(): ManagedClaudeStatus {
  const configDir = managedClaudeConfigDir();
  const base: ManagedClaudeStatus = {
    configDir,
    credentialsFound: false,
    loggedIn: false,
    expired: false,
    expiresAt: null,
    subscriptionType: null,
  };
  try {
    const raw = JSON.parse(
      readFileSync(`${configDir}/.credentials.json`, "utf8"),
    ) as Record<string, unknown>;
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
      configDir,
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
    return base;
  }
}

/**
 * Auth env vars that would override the subscription OAuth. Stripped before
 * spawning `claude` so the container's OWN login is always what authenticates
 * (orca's environment.ts pattern — otherwise a stray ANTHROPIC_API_KEY would
 * silently switch the worker to API billing).
 */
const CONFLICTING_AUTH_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_CUSTOM_HEADERS",
];

/**
 * Build the environment for spawning `claude` as a worker: the container's
 * isolated CLAUDE_CONFIG_DIR, with conflicting auth env stripped so the managed
 * subscription login is always used.
 */
export function claudeWorkerEnv(
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of CONFLICTING_AUTH_ENV) delete env[k];
  env.CLAUDE_CONFIG_DIR = managedClaudeConfigDir();
  return { ...env, ...extra };
}
