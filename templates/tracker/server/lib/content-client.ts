// Content MCP client — the tracker archives evidence documents to the content app
// by a STRUCTURED MCP `tools/call` over its `/_agent-native/mcp` endpoint.
// Auth is an HS256 JWT signed with the SHARED A2A_SECRET env (the tracker container
// MUST receive the same A2A_SECRET as the content app). NOT the A2A natural-language
// loop; this is a deterministic JSON-RPC call.
//
// Verified contract (content app src/mcp + build-server.ts):
//  - Endpoint: POST <base>/content/_agent-native/mcp  (stateless Streamable HTTP, JSON)
//  - Tool names are the action filename without `.ts`: create-document, etc.
//  - JWT: HS256, secret = A2A_SECRET, claims { sub, iat, exp, catalog_scope:"full" }.
//    `sub` is the authoritative actor identity. exp is enforced if present.
//  - Headers: Authorization: Bearer <jwt>, Accept: application/json,
//    text/event-stream (the SDK transport requires both advertised).

import crypto from "node:crypto";

/**
 * Base URL of the content app, reachable from the tracker container. Override with
 * CONTENT_BASE_URL.
 */
export function contentBaseUrl(): string {
  return (
    process.env.CONTENT_BASE_URL?.replace(/\/$/, "") || "http://an-content:3002"
  );
}

export function contentPublicBaseUrl(): string {
  return (
    process.env.CONTENT_PUBLIC_BASE?.replace(/\/$/, "") ||
    "http://192.168.1.101"
  );
}

export function contentDocumentUrl(
  urlPath: string | undefined,
  docId: string,
): string {
  return `${contentPublicBaseUrl()}/content${urlPath || `/page/${docId}`}`;
}

function mcpEndpoint(): string {
  return `${contentBaseUrl()}/content/_agent-native/mcp`;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** Mint an HS256 JWT for the content app MCP endpoint (no extra deps). */
export function mintContentJwt(actorEmail: string): string {
  const secret = process.env.A2A_SECRET;
  if (!secret) {
    throw new Error(
      "A2A_SECRET is not set — the tracker container must share the same " +
        "A2A_SECRET as the content app to dispatch over MCP.",
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

interface McpCallResult {
  /** Parsed JSON result of the action (from MCP structuredContent or text). */
  data: unknown;
  /** Raw MCP envelope for debugging. */
  raw: unknown;
}

/**
 * Call a content app action by its MCP tool name over JSON-RPC `tools/call`.
 * The content app endpoint is mounted under /content in the gateway and also at
 * the container root; we hit the gateway-prefixed path on the service host so
 * the same path works for both same-network and gateway routing.
 */
export async function callContentTool(
  actorEmail: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const jwt = mintContentJwt(actorEmail);
  const endpoint = mcpEndpoint();
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
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Content MCP ${toolName} failed (HTTP ${res.status}): ${text.slice(
        0,
        500,
      )}`,
    );
  }

  // The stateless transport can return either a JSON body or an SSE frame
  // (data: <json>). Parse both.
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
    throw new Error(`Content MCP ${toolName} error: ${rpc.error.message}`);
  }
  const result = rpc.result;
  if (!result) {
    throw new Error(`Content MCP ${toolName}: empty result`);
  }
  if (result.isError) {
    const msg = result.content?.find((c) => c.type === "text")?.text;
    throw new Error(`Content MCP ${toolName} tool error: ${msg ?? "?"}`);
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

function parseMcpResponse(text: string): unknown {
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
 * Convenience: create a document in the content app.
 * Returns the document metadata (id, urlPath, deepLink, etc.).
 */
export async function createContentDocument(
  actorEmail: string,
  params: { title: string; content: string },
): Promise<{
  id: string;
  urlPath?: string;
  deepLink?: string;
  [k: string]: unknown;
}> {
  const result = await callContentTool(actorEmail, "create-document", params);
  return result.data as {
    id: string;
    urlPath?: string;
    deepLink?: string;
    [k: string]: unknown;
  };
}
