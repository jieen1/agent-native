import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { managedClaudeConfigDir } from "./claude-managed-auth.js";

// Container-owned Claude Code SUBSCRIPTION login (DESIGN §13: NO ~/.claude
// copying). The orchestrator container drives its OWN OAuth 2.0 Authorization
// Code + PKCE flow into the isolated managed config dir and owns the resulting
// credential end-to-end — issuing the authorize URL, exchanging the code, and
// refreshing the single-use refresh token in place. The host's ~/.claude is
// never read, mounted, or copied: sharing one OAuth credential across host +
// container revokes it (refresh tokens are single-use; concurrent use rotates
// and invalidates), so the container holds an independent login.
//
// Every constant below was captured VERBATIM from the real `claude` CLI
// (v2.1.191) by driving `claude /login` (subscription) under a PTY in a
// throwaway environment and decoding the `oauth/authorize?...` URL it printed,
// plus the orca reference (`oauth-refresh.ts`) for the token endpoint. We match
// the CLI exactly so claude.com accepts our authorize request and so the
// credential we write is byte-compatible with what the CLI reads back.

/** Public Claude Code OAuth client id (verified: CLI v2.1.191 + orca). */
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/**
 * Authorize endpoint the CLI opens. NOTE: current CLI uses claude.com/cai/
 * (not the older claude.ai host). `code=true` asks the callback to render a
 * copyable authorization code for the manual paste flow.
 */
const OAUTH_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";

/** Token endpoint for code-exchange + refresh (verified: orca oauth-refresh). */
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

/**
 * Redirect URI the CLI registers — the console "show code" callback. The user
 * authorizes in the browser and the callback displays a `code#state` string to
 * paste back. Must match the authorize request exactly at token-exchange time.
 */
const OAUTH_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";

/**
 * Subscription-login scopes, captured verbatim from `claude /login` on
 * v2.1.191. (The narrower `setup-token` flow requests only `user:inference`;
 * subscription login requests the full set below.) Sent space-joined.
 */
const OAUTH_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
] as const;

/** Refresh this far ahead of expiry — the CLI uses the same 5-minute skew. */
const OAUTH_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const HTTP_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

function base64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** 32 random bytes → 43-char base64url, matching the CLI's verifier/state. */
function randomToken(): string {
  return base64Url(randomBytes(32));
}

/** S256 code challenge = base64url(sha256(code_verifier)). */
function s256Challenge(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier).digest());
}

// ---------------------------------------------------------------------------
// Login session state (in-memory)
// ---------------------------------------------------------------------------

export interface LoginSession {
  verifier: string;
  state: string;
  createdAt: number;
}

/** sessionId → PKCE material. In-memory only; a restart cancels pending logins. */
const sessions = new Map<string, LoginSession>();

/** Drop login sessions older than 15 minutes so the map can't grow unbounded. */
const SESSION_TTL_MS = 15 * 60 * 1000;
function pruneSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) {
    if (s.createdAt < cutoff) sessions.delete(id);
  }
}

export interface StartedLogin {
  sessionId: string;
  authUrl: string;
}

/**
 * Begin a subscription login: generate PKCE material, stash it under a fresh
 * session id, and build the exact authorize URL the user opens in their
 * browser. Nothing is written to disk yet — the credential is captured only
 * when the user pastes the code back into {@link completeLogin}.
 */
export function startLogin(): StartedLogin {
  pruneSessions();
  const verifier = randomToken();
  const state = randomToken();
  const challenge = s256Challenge(verifier);
  const sessionId = randomToken();
  sessions.set(sessionId, { verifier, state, createdAt: Date.now() });

  // Param order/keys mirror the captured CLI URL for parity. URLSearchParams
  // percent-encodes values (e.g. scope spaces → %20) the same way the CLI does.
  const params = new URLSearchParams({
    code: "true",
    client_id: OAUTH_CLIENT_ID,
    response_type: "code",
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: OAUTH_SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return { sessionId, authUrl: `${OAUTH_AUTHORIZE_URL}?${params.toString()}` };
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Claude token endpoint returned ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
      );
    }
    return (await res.json()) as TokenResponse;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Credential file I/O — the EXACT shape the `claude` CLI reads
// ---------------------------------------------------------------------------

/**
 * `claudeAiOauth` blob shape, verified against orca runtime-paths.ts /
 * oauth-refresh.ts and the live CLI: keys are accessToken, refreshToken,
 * expiresAt (ms epoch), scopes (array), subscriptionType.
 */
export interface ClaudeAiOauth {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType?: string;
}

function credentialsPath(): string {
  return join(managedClaudeConfigDir(), ".credentials.json");
}

function readOauthBlob(): ClaudeAiOauth | null {
  try {
    const raw = JSON.parse(readFileSync(credentialsPath(), "utf8")) as {
      claudeAiOauth?: Partial<ClaudeAiOauth>;
    };
    const o = raw.claudeAiOauth;
    if (!o || typeof o.accessToken !== "string") return null;
    return {
      accessToken: o.accessToken,
      refreshToken: typeof o.refreshToken === "string" ? o.refreshToken : "",
      expiresAt: typeof o.expiresAt === "number" ? o.expiresAt : 0,
      scopes: Array.isArray(o.scopes) ? o.scopes : [],
      subscriptionType:
        typeof o.subscriptionType === "string" ? o.subscriptionType : undefined,
    };
  } catch {
    return null;
  }
}

/** Write `.credentials.json` (0600) in the CLI's exact `{ claudeAiOauth }` shape. */
function writeOauthBlob(blob: ClaudeAiOauth): void {
  const dir = managedClaudeConfigDir();
  mkdirSync(dir, { recursive: true });
  const path = credentialsPath();
  writeFileSync(path, `${JSON.stringify({ claudeAiOauth: blob }, null, 2)}\n`, {
    mode: 0o600,
  });
  // Re-assert mode in case the file pre-existed with looser perms.
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort on platforms without chmod */
  }
}

function scopesFrom(response: TokenResponse): string[] {
  if (typeof response.scope === "string" && response.scope.trim() !== "") {
    return response.scope.split(" ").filter(Boolean);
  }
  return [...OAUTH_SCOPES];
}

// ---------------------------------------------------------------------------
// Authorization-code exchange (called on claudeConnectComplete)
// ---------------------------------------------------------------------------

/**
 * The console callback shows the code as `code#state` (or sometimes just the
 * code). Split it so we exchange the bare code and can cross-check the state.
 */
function parsePastedCode(pasted: string): {
  code: string;
  state: string | null;
} {
  const trimmed = pasted.trim();
  const hashIdx = trimmed.indexOf("#");
  if (hashIdx >= 0) {
    return {
      code: trimmed.slice(0, hashIdx),
      state: trimmed.slice(hashIdx + 1) || null,
    };
  }
  return { code: trimmed, state: null };
}

export interface CompleteLoginResult {
  loggedIn: boolean;
  error?: string;
}

/**
 * Exchange the pasted authorization code for tokens and write the managed
 * credential. Consumes the session (single use). Never throws — returns a
 * structured `{ loggedIn, error? }` for the action layer.
 */
export async function completeLogin(
  sessionId: string,
  pastedCode: string,
): Promise<CompleteLoginResult> {
  const session = sessions.get(sessionId);
  if (!session) {
    return {
      loggedIn: false,
      error: "Login session not found or expired. Start a new connect.",
    };
  }
  const { code, state } = parsePastedCode(pastedCode);
  if (!code) {
    return { loggedIn: false, error: "No authorization code was provided." };
  }
  // The CLI sends the verifier + the ORIGINAL state in the token body; some
  // callbacks echo a different state, so we trust our stored value but reject
  // an explicit mismatch as a CSRF guard.
  if (state && state !== session.state) {
    sessions.delete(sessionId);
    return {
      loggedIn: false,
      error: "OAuth state mismatch — aborting for safety.",
    };
  }
  try {
    const tokens = await postToken({
      grant_type: "authorization_code",
      code,
      code_verifier: session.verifier,
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: OAUTH_REDIRECT_URI,
      state: session.state,
    });
    if (!tokens.access_token || !tokens.refresh_token) {
      return {
        loggedIn: false,
        error: "Token endpoint did not return access/refresh tokens.",
      };
    }
    const expiresIn =
      typeof tokens.expires_in === "number" ? tokens.expires_in : 0;
    writeOauthBlob({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + expiresIn * 1000,
      scopes: scopesFrom(tokens),
      subscriptionType: "max",
    });
    sessions.delete(sessionId);
    return { loggedIn: true };
  } catch (err) {
    return {
      loggedIn: false,
      error: err instanceof Error ? err.message : "Token exchange failed.",
    };
  }
}

// ---------------------------------------------------------------------------
// Refresh ownership (single-use refresh token rotated + persisted in place)
// ---------------------------------------------------------------------------

export interface RefreshResult {
  refreshed: boolean;
  /** Why a refresh was skipped or failed — for diagnostics only, never a token. */
  reason?: string;
}

/**
 * Refresh the managed token when it is near expiry, rotating the single-use
 * refresh token and rewriting `.credentials.json` in place. Call this before
 * spawning a worker, or on a timer.
 *
 * - `force` refreshes even if the token isn't near expiry yet.
 * - Returns `{ refreshed: false }` (never throws) when there's nothing to do or
 *   the request fails, so callers safely keep the existing credential.
 */
export async function refreshManagedTokenIfNeeded(
  options: { force?: boolean; now?: number } = {},
): Promise<RefreshResult> {
  const now = options.now ?? Date.now();
  const blob = readOauthBlob();
  if (!blob) return { refreshed: false, reason: "no-credentials" };
  if (!blob.refreshToken)
    return { refreshed: false, reason: "no-refresh-token" };
  const needsRefresh =
    options.force || now + OAUTH_EXPIRY_BUFFER_MS >= blob.expiresAt;
  if (!needsRefresh) return { refreshed: false, reason: "not-expiring" };

  try {
    const tokens = await postToken({
      grant_type: "refresh_token",
      refresh_token: blob.refreshToken,
      client_id: OAUTH_CLIENT_ID,
    });
    if (!tokens.access_token)
      return { refreshed: false, reason: "no-access-token-in-response" };
    writeOauthBlob({
      accessToken: tokens.access_token,
      // Single-use refresh tokens: persist the rotated value when the server
      // issues one, otherwise keep the existing token.
      refreshToken:
        typeof tokens.refresh_token === "string" &&
        tokens.refresh_token.trim() !== ""
          ? tokens.refresh_token
          : blob.refreshToken,
      expiresAt:
        typeof tokens.expires_in === "number"
          ? now + tokens.expires_in * 1000
          : blob.expiresAt,
      scopes: tokens.scope ? scopesFrom(tokens) : blob.scopes,
      subscriptionType: blob.subscriptionType,
    });
    return { refreshed: true };
  } catch (err) {
    return {
      refreshed: false,
      reason: err instanceof Error ? err.message : "refresh-request-failed",
    };
  }
}

// ---------------------------------------------------------------------------
// Disconnect — delete the managed credential
// ---------------------------------------------------------------------------

/** Remove the managed `.credentials.json` so the container is logged out. */
export function disconnectManagedLogin(): void {
  rmSync(credentialsPath(), { force: true });
}

/** Exposed for the connected check / tests. */
export function hasManagedCredentials(): boolean {
  return readOauthBlob() !== null;
}

/**
 * Read the managed access token for a SERVER-SIDE Anthropic OAuth call (e.g. the
 * `oauth/usage` + `oauth/profile` endpoints the brain usage panel reads). This
 * is the ONLY accessor that returns token material — `getManagedClaudeStatus()`
 * intentionally never does. Callers MUST keep the value server-side (never log
 * it, never return it to a client) and SHOULD `refreshManagedTokenIfNeeded()`
 * first so a near-expiry token is rotated before use. Returns null when no
 * credential exists.
 */
export function readManagedAccessToken(): string | null {
  const blob = readOauthBlob();
  return blob?.accessToken && blob.accessToken.trim() !== ""
    ? blob.accessToken
    : null;
}

/** Exposed for diagnostics / tests — never returns token material. */
export const __oauthConstants = {
  OAUTH_CLIENT_ID,
  OAUTH_AUTHORIZE_URL,
  OAUTH_TOKEN_URL,
  OAUTH_REDIRECT_URI,
  OAUTH_SCOPES: [...OAUTH_SCOPES],
} as const;
