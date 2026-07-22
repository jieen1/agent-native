import crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  base64url,
  callMcpTool,
  makeMcpJwt,
  parseMcpResponse,
  unwrapArrayStructuredContent,
} from "../mcp-client.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.A2A_SECRET = "test-secret";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

// ──────────────────────────────────────────────────────────────────────────────
// 1. JWT claims
// ──────────────────────────────────────────────────────────────────────────────

describe("makeMcpJwt", () => {
  it("produces a valid HS256 JWT with the expected claims", () => {
    const secret = "my-secret";
    const sub = "owner@example.com";
    const jwt = makeMcpJwt(secret, sub);

    const [headerB64, payloadB64, sigB64] = jwt.split(".");
    expect(headerB64).toBeDefined();
    expect(payloadB64).toBeDefined();
    expect(sigB64).toBeDefined();

    // Decode header
    const header = JSON.parse(
      Buffer.from(
        headerB64!.replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString(),
    );
    expect(header).toEqual({ alg: "HS256", typ: "JWT" });

    // Decode payload
    const payload = JSON.parse(
      Buffer.from(
        payloadB64!.replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString(),
    );
    expect(payload.sub).toBe(sub);
    expect(payload.catalog_scope).toBe("full");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect(payload.exp - payload.iat).toBe(3600);
    // No orgId when not provided
    expect(payload.orgId).toBeUndefined();
  });

  it("includes orgId claim when provided", () => {
    const jwt = makeMcpJwt("secret", "user@test.com", "org-42");
    const [, payloadB64] = jwt.split(".");
    const payload = JSON.parse(
      Buffer.from(
        payloadB64!.replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString(),
    );
    expect(payload.orgId).toBe("org-42");
  });

  it("signature verifies against the secret via HMAC-SHA256", () => {
    const secret = "verify-me";
    const jwt = makeMcpJwt(secret, "actor@test.com");
    const [headerB64, payloadB64, sigB64] = jwt.split(".");
    const signingInput = `${headerB64}.${payloadB64}`;
    const expectedSig = base64url(
      crypto.createHmac("sha256", secret).update(signingInput).digest(),
    );
    expect(sigB64).toBe(expectedSig);
  });

  it("signature does NOT verify with a wrong secret", () => {
    const jwt = makeMcpJwt("correct-secret", "actor@test.com");
    const [headerB64, payloadB64, sigB64] = jwt.split(".");
    const signingInput = `${headerB64}.${payloadB64}`;
    const wrongSig = base64url(
      crypto.createHmac("sha256", "wrong-secret").update(signingInput).digest(),
    );
    expect(sigB64).not.toBe(wrongSig);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 2. JSON response parsing path
// ──────────────────────────────────────────────────────────────────────────────

describe("callMcpTool — JSON response parsing", () => {
  it("parses a plain JSON-RPC response and returns structuredContent as data", async () => {
    const payload = { id: "doc_1", title: "Hello" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [{ type: "text", text: JSON.stringify(payload) }],
              structuredContent: payload,
            },
          }),
      }),
    );

    const { data } = await callMcpTool({
      endpoint: "http://test:3002/test/_agent-native/mcp",
      toolName: "create-document",
      args: { title: "Hello" },
      secret: "test-secret",
      sub: "owner@example.com",
      label: "Test MCP",
    });

    expect(data).toEqual(payload);
  });

  it("falls back to parsing content[0].text as JSON when structuredContent is absent", async () => {
    const arr = [{ id: "x" }];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [{ type: "text", text: JSON.stringify(arr) }],
            },
          }),
      }),
    );

    const { data } = await callMcpTool({
      endpoint: "http://test:3002/test/_agent-native/mcp",
      toolName: "some-tool",
      args: {},
      secret: "test-secret",
      sub: "owner@example.com",
      label: "Test MCP",
    });

    expect(data).toEqual(arr);
  });

  it("falls back to raw text when content[0].text is not valid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [{ type: "text", text: "just a plain string" }],
            },
          }),
      }),
    );

    const { data } = await callMcpTool({
      endpoint: "http://test:3002/test/_agent-native/mcp",
      toolName: "some-tool",
      args: {},
      secret: "test-secret",
      sub: "owner@example.com",
      label: "Test MCP",
    });

    expect(data).toBe("just a plain string");
  });

  it("throws on JSON-RPC error envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { message: "tool not found" },
          }),
      }),
    );

    await expect(
      callMcpTool({
        endpoint: "http://test:3002/test/_agent-native/mcp",
        toolName: "bad-tool",
        args: {},
        secret: "test-secret",
        sub: "owner@example.com",
        label: "Test MCP",
      }),
    ).rejects.toThrow("Test MCP bad-tool error: tool not found");
  });

  it("throws on HTTP error with status in message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      }),
    );

    await expect(
      callMcpTool({
        endpoint: "http://test:3002/test/_agent-native/mcp",
        toolName: "some-tool",
        args: {},
        secret: "test-secret",
        sub: "owner@example.com",
        label: "Test MCP",
      }),
    ).rejects.toThrow("Test MCP some-tool failed (HTTP 500)");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 3. SSE (text/event-stream) response parsing path
// ──────────────────────────────────────────────────────────────────────────────

describe("callMcpTool — SSE response parsing", () => {
  it("parses an SSE-framed response (data: <json>)", async () => {
    const payload = { status: "done" };
    const sseBody = [
      "event: message",
      `data: ${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
        },
      })}`,
      "",
    ].join("\n");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => sseBody,
      }),
    );

    const { data } = await callMcpTool({
      endpoint: "http://test:3002/test/_agent-native/mcp",
      toolName: "runsList",
      args: {},
      secret: "test-secret",
      sub: "owner@example.com",
      label: "Test MCP",
    });

    expect(data).toEqual(payload);
  });

  it("uses the LAST data: line when multiple SSE frames are present", async () => {
    const finalPayload = { final: true };
    const sseBody = [
      "event: message",
      `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [], structuredContent: { partial: true } } })}`,
      "",
      "event: message",
      `data: ${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{ type: "text", text: JSON.stringify(finalPayload) }],
          structuredContent: finalPayload,
        },
      })}`,
      "",
    ].join("\n");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => sseBody,
      }),
    );

    const { data } = await callMcpTool({
      endpoint: "http://test:3002/test/_agent-native/mcp",
      toolName: "some-tool",
      args: {},
      secret: "test-secret",
      sub: "owner@example.com",
      label: "Test MCP",
    });

    expect(data).toEqual(finalPayload);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 4. readOnly { items: [...] } structuredContent unwrap
// ──────────────────────────────────────────────────────────────────────────────

describe("callMcpTool — readOnly { items: [...] } unwrap", () => {
  it("unwraps { items: [...] } to a plain array when unwrapArrayItems is true", async () => {
    const nodes = [{ id: "n1", status: "done" }];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [{ type: "text", text: JSON.stringify(nodes) }],
              structuredContent: { items: nodes },
            },
          }),
      }),
    );

    const { data } = await callMcpTool({
      endpoint: "http://test:3002/test/_agent-native/mcp",
      toolName: "runsList",
      args: {},
      secret: "test-secret",
      sub: "owner@example.com",
      label: "Test MCP",
      unwrapArrayItems: true,
    });

    expect(Array.isArray(data)).toBe(true);
    expect(data).toEqual(nodes);
  });

  it("does NOT unwrap when unwrapArrayItems is false/absent", async () => {
    const nodes = [{ id: "n1" }];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [{ type: "text", text: JSON.stringify(nodes) }],
              structuredContent: { items: nodes },
            },
          }),
      }),
    );

    const { data } = await callMcpTool({
      endpoint: "http://test:3002/test/_agent-native/mcp",
      toolName: "create-document",
      args: {},
      secret: "test-secret",
      sub: "owner@example.com",
      label: "Test MCP",
      // unwrapArrayItems not set
    });

    expect(data).toEqual({ items: nodes });
  });

  it("does NOT unwrap a multi-key object that has an items field", async () => {
    const payload = { items: [1, 2, 3], total: 3 };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [{ type: "text", text: JSON.stringify(payload) }],
              structuredContent: payload,
            },
          }),
      }),
    );

    const { data } = await callMcpTool({
      endpoint: "http://test:3002/test/_agent-native/mcp",
      toolName: "paginated-tool",
      args: {},
      secret: "test-secret",
      sub: "owner@example.com",
      label: "Test MCP",
      unwrapArrayItems: true,
    });

    expect(data).toEqual(payload);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Unit tests for exported helpers
// ──────────────────────────────────────────────────────────────────────────────

describe("parseMcpResponse", () => {
  it("parses a JSON object body", () => {
    const obj = { jsonrpc: "2.0", id: 1, result: {} };
    expect(parseMcpResponse(JSON.stringify(obj))).toEqual(obj);
  });

  it("parses a JSON array body", () => {
    const arr = [1, 2, 3];
    expect(parseMcpResponse(JSON.stringify(arr))).toEqual(arr);
  });

  it("parses an SSE data: frame", () => {
    const obj = { hello: "world" };
    const sse = `event: message\ndata: ${JSON.stringify(obj)}\n\n`;
    expect(parseMcpResponse(sse)).toEqual(obj);
  });

  it("throws on unparseable content", () => {
    expect(() => parseMcpResponse("garbage no data")).toThrow(
      "Unparseable MCP response",
    );
  });
});

describe("unwrapArrayStructuredContent", () => {
  it("unwraps single-key { items: [...] }", () => {
    expect(unwrapArrayStructuredContent({ items: [1, 2] })).toEqual([1, 2]);
  });

  it("leaves multi-key objects alone", () => {
    const obj = { items: [1], count: 1 };
    expect(unwrapArrayStructuredContent(obj)).toBe(obj);
  });

  it("leaves arrays alone", () => {
    const arr = [1, 2, 3];
    expect(unwrapArrayStructuredContent(arr)).toBe(arr);
  });

  it("leaves null/undefined/primitives alone", () => {
    expect(unwrapArrayStructuredContent(null)).toBe(null);
    expect(unwrapArrayStructuredContent(undefined)).toBe(undefined);
    expect(unwrapArrayStructuredContent("str")).toBe("str");
  });
});
