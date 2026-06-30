// Brain MCP config — mints the A2A bearer the brain's Claude Code session uses
// to reach the orchestrator actions as MCP tools, and writes the .mcp.json the
// `claude` CLI loads with --mcp-config.
//
// VERIFIED RECIPE (proven against the live an-orchestrator container):
// The MCP endpoint verifies an HS256 JWT signed with env A2A_SECRET via
// jose.jwtVerify — no issuer/audience requirement (see
// packages/core/src/mcp/build-server.ts verifyA2AJwtForMcp). The token MUST NOT
// carry a `scope` claim: verifyAuth rejects any A2A token whose `scope` is not
// the connect scope. `sub` becomes the scoped user; `catalog_scope: "full"`
// bypasses the connector-catalog tier filter so the full action surface is
// exposed. We sign with node:crypto HMAC-SHA256 (no jose dependency in the
// template) — the framework verifies with the same secret.

import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MCP_URL = "http://localhost:3002/_agent-native/mcp";
const TOKEN_TTL_SECONDS = 24 * 60 * 60; // 24h

/**
 * Root for per-thread brain MCP config dirs, OUTSIDE any workspace checkout.
 * The `.mcp.json` carries a live A2A bearer; it must NEVER live inside the
 * workspace cwd or `git add -A` would sweep it into a commit and leak the token
 * to the remote. We keep the brain's cwd on the workspace but pin the config to
 * a managed dir under the OS temp root (override with ORCH_BRAIN_MCP_DIR).
 */
export const BRAIN_MCP_CONFIG_ROOT =
  process.env.ORCH_BRAIN_MCP_DIR?.trim() || join(tmpdir(), "brain-mcp");

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Mint the brain's MCP bearer: an HS256 JWT signed with A2A_SECRET, payload
 * `{ sub: <ownerEmail>, iat, exp (+24h), catalog_scope: "full" }`. No `scope`
 * claim (would be rejected). Throws if A2A_SECRET is unset — the brain cannot
 * authenticate to the MCP endpoint without it.
 */
export function mintBrainToken(ownerEmail: string): string {
  const secret = process.env.A2A_SECRET?.trim();
  if (!secret) {
    throw new Error(
      "A2A_SECRET is not set — the brain cannot mint an MCP token. Set " +
        "A2A_SECRET on the orchestrator so the brain's Claude Code session can " +
        "reach the orchestrator actions over MCP.",
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub: ownerEmail,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
    catalog_scope: "full",
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(payload),
  )}`;
  const signature = base64url(
    createHmac("sha256", secret).update(signingInput).digest(),
  );
  return `${signingInput}.${signature}`;
}

/**
 * Write the `.mcp.json` the brain's `claude` CLI loads with --mcp-config into a
 * managed per-session dir OUTSIDE the workspace, and return its absolute path.
 *
 * SECURITY (credential-leak fix): this file carries a live A2A bearer. If it
 * lived inside the workspace cwd, `workspaceCommit`'s `git add -A` would sweep
 * it into a commit and leak the token to the remote. We therefore write it to
 * `${BRAIN_MCP_CONFIG_ROOT}/<sessionKey>/.mcp.json` (sessionKey is sanitized to
 * a safe path segment, e.g. the threadId) and pass that ABSOLUTE path to
 * `claude --mcp-config`. The brain's cwd stays the workspace; the config never
 * lives in it.
 *
 * The orchestrator MCP server is Streamable HTTP; the bearer is minted for
 * `ownerEmail` and the X-Agent-Native-Owner-Email header pins the scoped
 * identity.
 */
export function writeBrainMcpConfig(
  sessionKey: string,
  ownerEmail: string,
): string {
  const token = mintBrainToken(ownerEmail);
  const config = {
    mcpServers: {
      orchestrator: {
        type: "http",
        url: MCP_URL,
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Agent-Native-Owner-Email": ownerEmail,
        },
      },
    },
  };
  // Sanitize the session key into a single safe path segment so it can never
  // escape the managed root (no slashes, no `..`).
  const safeKey =
    sessionKey.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "") || "default";
  const dir = join(BRAIN_MCP_CONFIG_ROOT, safeKey);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, ".mcp.json");
  writeFileSync(path, JSON.stringify(config, null, 2), "utf8");
  return path;
}
