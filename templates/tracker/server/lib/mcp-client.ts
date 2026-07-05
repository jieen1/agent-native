// Shared MCP `tools/call` transport for the tracker's deterministic dispatch
// links to sibling apps (orchestrator, content). Auth is an HS256 JWT signed
// with the SHARED A2A_SECRET env (the tracker container MUST receive the same
// A2A_SECRET as the sibling app). NOT the A2A natural-language loop (which
// would need an online chat LLM); this is a deterministic JSON-RPC call.
//
// This module owns ONLY the parts that were byte-for-byte duplicated between
// `orchestrator-client.ts` and `content-client.ts`: JWT minting and the MCP
// HTTP transport + response parsing (JSON body or SSE `data:` frame, then
// `structuredContent` → `content[].text` extraction). Each sibling app keeps
// its own thin wrapper file for base-URL resolution, its tool-name convenience
// functions, and any app-specific response massaging (e.g. content-client's
// upload-url fallbacks).
//
// Verified contract (both sibling apps' src/mcp + build-server.ts):
//  - Endpoint: POST <base>/_agent-native/mcp  (stateless Streamable HTTP, JSON)
//  - Tool names are the action filename without `.ts` (hyphens preserved, no
//    namespacing over the wire).
//  - JWT: HS256, secret = A2A_SECRET, claims { sub, iat, exp, catalog_scope:"full" }.
//    `sub` is the authoritative actor identity. exp is enforced if present.
//  - Headers: Authorization: Bearer <jwt>, Accept: application/json,
//    text/event-stream (the SDK transport requires both advertised).

import crypto from "node:crypto";

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Mint an HS256 JWT for a sibling app's MCP endpoint (no extra deps).
 *
 * `appDescription` is interpolated verbatim into the "A2A_SECRET is not set"
 * error message as `... share the same A2A_SECRET as ${appDescription} to
 * dispatch over MCP.` — pass e.g. "the orchestrator" or "the content app" so
 * each wrapper's error text stays exactly what it was before this refactor.
 */
export function mintA2aJwt(actorEmail: string, appDescription: string): string {
  const secret = process.env.A2A_SECRET;
  if (!secret) {
    throw new Error(
      "A2A_SECRET is not set — the tracker container must share the same " +
        `A2A_SECRET as ${appDescription} to dispatch over MCP.`,
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub: actorEmail,
    iat: now,
    exp: now + 3600,
    catalog_scope: "full",
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(payload),
  )}`;
  const signature = base64url(
    crypto.createHmac("sha256", secret).update(signingInput).digest(),
  );
  return `${signingInput}.${signature}`;
}

export interface McpCallResult {
  /** Parsed JSON result of the action (from MCP structuredContent or text). */
  data: unknown;
  /** Raw MCP envelope for debugging. */
  raw: unknown;
}

/**
 * Parse an MCP HTTP response body. The stateless transport can return either
 * a JSON body or an SSE frame (`data: <json>`) — parse both.
 */
export function parseMcpResponse(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  // SSE: find the last `data:` line and parse it.
  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.startsWith("data:")) {
      return JSON.parse(line.slice("data:".length).trim());
    }
  }
  throw new Error(`Unparseable MCP response: ${trimmed.slice(0, 200)}`);
}

/**
 * Call a sibling app's action by its MCP tool name over JSON-RPC `tools/call`.
 * Shared transport for `callOrchestratorTool` and `callContentTool` — each
 * caller supplies its own resolved `endpoint`, the exact `appLabel` string used
 * to prefix error messages (e.g. "Orchestrator" / "Content", preserved
 * verbatim from the pre-refactor call sites), the description used inside the
 * missing-A2A_SECRET message (see `mintA2aJwt`), and any extra headers (e.g.
 * content's inline-apps opt-in header).
 */
export async function callMcpTool(opts: {
  endpoint: string;
  actorEmail: string;
  appLabel: string;
  appDescription: string;
  toolName: string;
  args: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
}): Promise<McpCallResult> {
  const {
    endpoint,
    actorEmail,
    appLabel,
    appDescription,
    toolName,
    args,
    extraHeaders,
  } = opts;
  const jwt = mintA2aJwt(actorEmail, appDescription);
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${jwt}`,
      "X-Agent-Native-Owner-Email": actorEmail,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `${appLabel} MCP ${toolName} failed (HTTP ${res.status}): ${text.slice(
        0,
        500,
      )}`,
    );
  }

  const parsed = parseMcpResponse(text);
  const rpc = parsed as {
    error?: { message?: string };
    result?: {
      isError?: boolean;
      structuredContent?: unknown;
      content?: Array<{ type: string; text?: string }>;
    };
  };
  if (rpc.error) {
    throw new Error(`${appLabel} MCP ${toolName} error: ${rpc.error.message}`);
  }
  const result = rpc.result;
  if (!result) {
    throw new Error(`${appLabel} MCP ${toolName}: empty result`);
  }
  if (result.isError) {
    const msg = result.content?.find((c) => c.type === "text")?.text;
    throw new Error(`${appLabel} MCP ${toolName} tool error: ${msg ?? "?"}`);
  }

  let data: unknown = result.structuredContent;
  if (data === undefined) {
    const textPart = result.content?.find((c) => c.type === "text")?.text;
    if (textPart) {
      try {
        data = JSON.parse(textPart);
      } catch {
        data = textPart;
      }
    }
  }
  return { data, raw: parsed };
}
