// Regression coverage for the full-MCP-catalog production incident: the brain
// used to mint its MCP bearer with `catalog_scope: "full"`, which bypasses the
// connector-catalog tier filter in packages/core/src/mcp/build-server.ts and
// serves the ENTIRE ~187-tool action catalog on every brain turn. That caused
// a real production failure — an Aliyun OpenAI-compatible endpoint's stricter
// function-calling schema validator rejected one of the 187 tools' JSON
// schema (`list_apps`), killing the whole turn with a real
// `400 InternalError.Algo.InvalidParameter` (thread
// bt_0edbab39-c061-4eb4-a681-4f0ee1ef0bb4). The fix: the brain's token no
// longer requests the full catalog; `server/plugins/agent-chat.ts` declares a
// curated `connectorCatalog` instead. These tests pin the token shape so a
// future change can't silently reintroduce `catalog_scope: "full"`.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildBrainMcpServers,
  mintBrainToken,
  writeBrainMcpConfig,
} from "./brain-mcp-config.js";

function decodeJwtPayload(token: string): Record<string, unknown> {
  const [, payloadSegment] = token.split(".");
  const normalized = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

describe("mintBrainToken", () => {
  const OLD_A2A_SECRET = process.env.A2A_SECRET;

  beforeEach(() => {
    process.env.A2A_SECRET = "test-a2a-secret";
  });

  afterEach(() => {
    if (OLD_A2A_SECRET === undefined) delete process.env.A2A_SECRET;
    else process.env.A2A_SECRET = OLD_A2A_SECRET;
  });

  it("does NOT request the full MCP catalog (no catalog_scope claim)", () => {
    const token = mintBrainToken("owner@example.com");
    const payload = decodeJwtPayload(token);
    expect(payload).not.toHaveProperty("catalog_scope");
  });

  it("never carries a `scope` claim (verifyAuth rejects non-connect scopes)", () => {
    const token = mintBrainToken("owner@example.com");
    const payload = decodeJwtPayload(token);
    expect(payload).not.toHaveProperty("scope");
  });

  it("carries the expected sub/iat/exp shape and nothing else", () => {
    const token = mintBrainToken("owner@example.com");
    const payload = decodeJwtPayload(token);
    expect(payload.sub).toBe("owner@example.com");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect(Object.keys(payload).sort()).toEqual(["exp", "iat", "sub"]);
  });

  it("throws when A2A_SECRET is unset", () => {
    delete process.env.A2A_SECRET;
    expect(() => mintBrainToken("owner@example.com")).toThrow(/A2A_SECRET/);
  });
});

describe("buildBrainMcpServers (ACP harness path)", () => {
  const OLD_A2A_SECRET = process.env.A2A_SECRET;

  beforeEach(() => {
    process.env.A2A_SECRET = "test-a2a-secret";
  });

  afterEach(() => {
    if (OLD_A2A_SECRET === undefined) delete process.env.A2A_SECRET;
    else process.env.A2A_SECRET = OLD_A2A_SECRET;
  });

  it("mints a bearer with no catalog_scope claim in the Authorization header", () => {
    const [server] = buildBrainMcpServers("owner@example.com");
    const headers = server.headers as Array<{ name: string; value: string }>;
    const authHeader = headers.find((h) => h.name === "Authorization");
    expect(authHeader).toBeDefined();
    const bearer = authHeader!.value.replace(/^Bearer /, "");
    const payload = decodeJwtPayload(bearer);
    expect(payload).not.toHaveProperty("catalog_scope");
  });
});

describe("writeBrainMcpConfig (raw-spawn CLI path)", () => {
  const OLD_A2A_SECRET = process.env.A2A_SECRET;
  const OLD_MCP_DIR = process.env.ORCH_BRAIN_MCP_DIR;

  beforeEach(async () => {
    process.env.A2A_SECRET = "test-a2a-secret";
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs");
    process.env.ORCH_BRAIN_MCP_DIR = fs.mkdtempSync(
      path.join(os.tmpdir(), "brain-mcp-config-spec-"),
    );
  });

  afterEach(() => {
    if (OLD_A2A_SECRET === undefined) delete process.env.A2A_SECRET;
    else process.env.A2A_SECRET = OLD_A2A_SECRET;
    if (OLD_MCP_DIR === undefined) delete process.env.ORCH_BRAIN_MCP_DIR;
    else process.env.ORCH_BRAIN_MCP_DIR = OLD_MCP_DIR;
  });

  it("writes a .mcp.json whose bearer has no catalog_scope claim", async () => {
    const fs = await import("node:fs");
    const configPath = writeBrainMcpConfig("thread-1", "owner@example.com");
    const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const bearer = (
      written.mcpServers.orchestrator.headers.Authorization as string
    ).replace(/^Bearer /, "");
    const payload = decodeJwtPayload(bearer);
    expect(payload).not.toHaveProperty("catalog_scope");
  });
});
