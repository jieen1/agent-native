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

import {
  callMcpTool,
  makeMcpJwt,
  type McpCallResult,
} from "./mcp-client.js";

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
    process.env.WORKSPACE_GATEWAY_URL?.replace(/\/$/, "") ||
    "http://localhost"
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

/** Mint an HS256 JWT for the content app MCP endpoint (no extra deps). */
export function mintContentJwt(actorEmail: string): string {
  const secret = process.env.A2A_SECRET;
  if (!secret) {
    throw new Error(
      "A2A_SECRET is not set — the tracker container must share the same " +
        "A2A_SECRET as the content app to dispatch over MCP.",
    );
  }
  return makeMcpJwt(secret, actorEmail);
}

export type { McpCallResult };

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
  const secret = process.env.A2A_SECRET;
  if (!secret) {
    throw new Error(
      "A2A_SECRET is not set — the tracker container must share the same " +
        "A2A_SECRET as the content app to dispatch over MCP.",
    );
  }
  return callMcpTool({
    endpoint: mcpEndpoint(),
    toolName,
    args,
    secret,
    sub: actorEmail,
    label: "Content MCP",
    extraHeaders: {
      // Content's `create-document` is a mutating action that declares an
      // `mcpApp.resource` (embeddable editor), so the MCP server only puts
      // the action's full result object into `structuredContent` when the
      // caller opts into inline MCP-App rendering — otherwise it only
      // returns a lossy, human-readable summary string in `content[].text`
      // (e.g. "<title> (<id>) is ready.") and NO `structuredContent` at all.
      // Request inline rendering so we reliably get `{id, urlPath, ...}`
      // back in `structuredContent` instead of having to scrape prose text.
      "x-agent-native-mcp-inline-apps": "1",
    },
  });
}

/**
 * Fallback: pull a document id out of the `_meta["agent-native/openLink"]`
 * webUrl/desktopUrl query string (`?...&documentId=<id>&...`). This metadata
 * is attached to the tool result independent of the structuredContent gating,
 * so it's a reliable fallback when the inline-apps header is somehow ignored
 * or an older content deployment doesn't set it.
 */
function extractDocumentIdFromOpenLink(
  meta: Record<string, unknown> | undefined,
): string | undefined {
  const openLink = meta?.["agent-native/openLink"] as
    | { webUrl?: string; desktopUrl?: string }
    | undefined;
  if (!openLink) return undefined;
  for (const candidate of [openLink.webUrl, openLink.desktopUrl]) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      const id = url.searchParams.get("documentId");
      if (id) return id;
    } catch {
      const qIdx = candidate.indexOf("?");
      if (qIdx >= 0) {
        const id = new URLSearchParams(candidate.slice(qIdx + 1)).get(
          "documentId",
        );
        if (id) return id;
      }
    }
  }
  return undefined;
}

/**
 * Last-resort fallback: scrape the concise human-readable summary text
 * (e.g. "<title> (<id>) is ready.") that the MCP server emits in
 * `content[].text` when structuredContent isn't available.
 */
function extractDocumentIdFromText(
  content: Array<{ type: string; text?: string }> | undefined,
): string | undefined {
  if (!content) return undefined;
  for (const block of content) {
    if (block.type !== "text" || !block.text) continue;
    const match = block.text.match(/\(([^()\s]+)\)\s*is ready\.?\s*$/);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/**
 * Convenience: create a document in the content app.
 * Returns the document metadata (id, urlPath, deepLink, etc.).
 *
 * The primary path relies on `callContentTool` requesting inline MCP-App
 * rendering so `structuredContent` carries the full `{id, urlPath, ...}`
 * object. Belt-and-suspenders: if `id` is still missing (an older content
 * deployment, a gateway that strips the header, etc.), fall back to the
 * `_meta["agent-native/openLink"]` URL's `documentId` query param, then to
 * regex-scraping the concise summary text. If none of those resolve an id,
 * throw a clear error instead of silently returning `undefined` (the
 * original bug: a bad id produced `.../content/page/undefined` with no
 * exception raised).
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
  const data = (result.data ?? {}) as {
    id?: string;
    urlPath?: string;
    deepLink?: string;
    [k: string]: unknown;
  };

  let id = typeof data.id === "string" && data.id ? data.id : undefined;

  const rpcResult = (
    result.raw as {
      result?: {
        _meta?: Record<string, unknown>;
        content?: Array<{ type: string; text?: string }>;
      };
    }
  )?.result;

  if (!id) {
    id = extractDocumentIdFromOpenLink(rpcResult?._meta);
  }
  if (!id) {
    id = extractDocumentIdFromText(rpcResult?.content);
  }
  if (!id) {
    throw new Error(
      "Content MCP create-document: could not resolve a document id from " +
        "structuredContent, openLink metadata, or the summary text.",
    );
  }

  return { ...data, id };
}

/**
 * Normalize a URL returned by the content app's `upload-image` action into an
 * absolute, publicly reachable URL. The content app's upload provider returns
 * a path relative to ITS OWN app root (e.g. `/api/uploads/local/2026/07/x.png`
 * or already-absolute when an S3 public base URL is configured) — mirrors the
 * same `/content` gateway-prefix convention as `contentDocumentUrl` above.
 */
export function contentImageUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const path = url.startsWith("/") ? url : `/${url}`;
  return `${contentPublicBaseUrl()}/content${path}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Fallback helpers for upload-image MCP response
//
// Background (packages/core side limitation, bypassed here on tracker side):
//
//   `upload-image` is a "pure" core action — it does NOT declare `mcpApp.resource`
//   nor `readOnly:true`.  The MCP server (packages/core/src/mcp/build-server.ts)
//   will therefore never return `structuredContent` for it, regardless of
//   `x-agent-native-mcp-inline-apps` header.  Instead `content[].text` carries a
//   lossy, human-readable summary produced by `conciseToolResultText`, whose field
//   priority is: message/summary → id → url → JSON.stringify fallback.
//
//   Because the upload-storage-provider always returns a non-empty `id` field
//   (e.g. `"local:2026/07/xxx.png"` or `"s3:2026/07/xxx.png"`), the concise text
//   short-circuits at `id` and produces:
//     `"upload-image completed for local:2026/07/xxx.png."`
//   — the `url` field is lost.  `callContentTool` above tries `JSON.parse` on this
//   text, fails, and falls through to assigning the raw string to `result.data`.
//
//   The helpers below scrape the id out of that summary string, then map the
//   storage id back to the content app's proxy route
//   `/api/uploads/<local|s3>/<objectKey>` which is always readable (see
//   templates/content/server/lib/upload-storage-provider.ts top comments).
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Extract the storage id out of the concise summary text emitted by
 * `conciseToolResultText` when structuredContent is not available.
 *
 * Expected format: `"upload-image completed for <id>."`
 * The trailing period is optional (the core code trims inconsistently).
 */
function extractUploadIdFromConciseText(text: string): string | undefined {
  const match = text.trim().match(/completed for (\S+?)\.?$/);
  return match?.[1];
}

/**
 * Map a content storage id (e.g. `"local:2026/07/xxx.png"` or
 * `"s3:2026/07/xxx.png"`) back to the content app's always-readable
 * proxy route `/api/uploads/<kind>/<objectKey>`.
 *
 * See templates/content/server/lib/upload-storage-provider.ts — the provider
 * always returns `local:<key>` or `s3:<key>`, and the content app registers
 * `/api/uploads/:provider/:key*` proxy routes that work regardless of S3
 * public base URL configuration.
 */
function uploadPathFromStorageId(id: string): string | undefined {
  const match = id.trim().match(/^(local|s3):(.+)$/);
  if (!match) return undefined;
  const [, kind, objectKey] = match;
  return `/api/uploads/${kind}/${objectKey}`;
}

/**
 * Upload image bytes (as a base64 data URL) to the content app's storage via
 * its shared `upload-image` core action (S3/MinIO when content has storage
 * env vars configured, else content's local-disk fallback — see
 * templates/content/server/lib/upload-storage-provider.ts). Returns an
 * absolute, publicly reachable image URL suitable for embedding in markdown.
 *
 * Falls back to scraping the concise summary text when structuredContent is
 * missing (see helpers above for background on why this is necessary).
 */
export async function uploadContentImage(
  actorEmail: string,
  params: { data: string; filename?: string },
): Promise<{ url: string; id?: string; provider?: string }> {
  const result = await callContentTool(actorEmail, "upload-image", params);
  const data = (result.data ?? {}) as {
    url?: string;
    id?: string;
    provider?: string;
    error?: string;
  };

  let rawUrl = typeof data.url === "string" && data.url ? data.url : undefined;
  let id = typeof data.id === "string" && data.id ? data.id : undefined;

  // upload-image is a "pure" core action (no mcpApp.resource / readOnly), so
  // the MCP server never returns structuredContent for it.  content[].text is a
  // lossy summary that drops the url field (see module-level comment above).
  // When result.data is a string, it is that summary text — scrape the id out
  // and convert it to a readable proxy path as a fallback.
  if (!rawUrl && !data.error && typeof result.data === "string") {
    const scrapedId = extractUploadIdFromConciseText(result.data);
    const path = scrapedId ? uploadPathFromStorageId(scrapedId) : undefined;
    if (path) {
      rawUrl = path;
      id = id ?? scrapedId;
    }
  }

  if (data.error || !rawUrl) {
    throw new Error(
      data.error || "Content MCP upload-image: no url in response",
    );
  }

  return {
    url: contentImageUrl(rawUrl),
    id,
    provider: data.provider,
  };
}
