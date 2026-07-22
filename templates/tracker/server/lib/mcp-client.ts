// Shared MCP client helpers — HS256 JWT minting and JSON-RPC `tools/call`
// fetch/parse logic used by both orchestrator-client.ts and content-client.ts.
// Dependency-free (node:crypto only), ESM, .js import suffixes.

import crypto from "node:crypto";

/** Base64url-encode (RFC 7515 §2) without padding. */
export function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Mint an HS256 JWT for an MCP endpoint (no extra deps).
 * Claims: { sub, iat, exp (now+3600), catalog_scope:"full" }.
 * If orgId is provided it is included as an additional claim.
 */
export function makeMcpJwt(secret: string, sub: string, orgId?: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload: Record<string, unknown> = {
    sub,
    iat: now,
    exp: now + 3600,
    catalog_scope: "full",
  };
  if (orgId) {
    payload.orgId = orgId;
  }
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

export interface CallMcpToolOpts {
  /** Fully resolved MCP endpoint URL. */
  endpoint: string;
  /** MCP tool name (action filename without .ts). */
  toolName: string;
  /** Tool arguments. */
  args: Record<string, unknown>;
  /** HS256 shared secret (A2A_SECRET). */
  secret: string;
  /** Actor identity for the JWT `sub` claim and X-Agent-Native-Owner-Email header. */
  sub: string;
  /** Label for error messages, e.g. "Orchestrator MCP" or "Content MCP". */
  label: string;
  /** Additional headers to include in the request (e.g. content's inline-apps header). */
  extraHeaders?: Record<string, string>;
  /**
   * When true, unwrap a readOnly action's `{ items: [...] }` structuredContent
   * box back to the plain array (orchestrator's readOnly tools always box
   * bare-array results this way).
   */
  unwrapArrayItems?: boolean;
}

/**
 * Call an MCP tool over JSON-RPC `tools/call` with HS256 JWT auth.
 * Handles both JSON and SSE (text/event-stream) response formats.
 */
export async function callMcpTool(opts: CallMcpToolOpts): Promise<McpCallResult> {
  const { endpoint, toolName, args, secret, sub, label, extraHeaders, unwrapArrayItems } = opts;
  const jwt = makeMcpJwt(secret, sub);
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
      "X-Agent-Native-Owner-Email": sub,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `${label} ${toolName} failed (HTTP ${res.status}): ${text.slice(0, 500)}`,
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
    throw new Error(`${label} ${toolName} error: ${rpc.error.message}`);
  }
  const result = rpc.result;
  if (!result) {
    throw new Error(`${label} ${toolName}: empty result`);
  }
  if (result.isError) {
    const msg = result.content?.find((c) => c.type === "text")?.text;
    throw new Error(`${label} ${toolName} tool error: ${msg ?? "?"}`);
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
  } else if (unwrapArrayItems) {
    data = unwrapArrayStructuredContent(data);
  }
  return { data, raw: parsed };
}

// The orchestrator's MCP server wraps a `readOnly: true` action's bare-array
// result as `{ items: [...] }` in `structuredContent` (see build-server.ts's
// `readOnlyStructuredResult` — MCP structuredContent must be a JSON object,
// so a bare array gets boxed under a single `items` key; `content[0].text`
// keeps the unwrapped array for display). Every array-shaped read this file
// calls (`runsList`, `spawnList`, `v3RunNodes`) is `readOnly: true`, so their
// structuredContent always arrives wrapped — callers here expect
// `Array.isArray(data)` to be true (get-activity.ts's runs/spawns/nodes
// checks), so unwrap the single-key `{ items: [...] }` envelope back to the
// plain array. Never unwraps a legitimate multi-key object.
export function unwrapArrayStructuredContent(data: unknown): unknown {
  if (
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    Object.keys(data as Record<string, unknown>).length === 1 &&
    Array.isArray((data as { items?: unknown }).items)
  ) {
    return (data as { items: unknown[] }).items;
  }
  return data;
}

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
