import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { callOrchestratorTool } from "../orchestrator-client.js";

// ============================================================================
// Regression: get-activity.ts's `runsList` / `spawnList` / `v3RunNodes` reads
// came back empty in production (SDLC-041/043/040 all had confirmed real,
// completed v3_runs with real DAG nodes, yet the tracker work-item detail
// page's "关联运行"/证据链 evidence never rendered anything).
//
// Root cause: the orchestrator's MCP server boxes a `readOnly: true` action's
// bare-ARRAY result as `{ items: [...] }` in `structuredContent` (JSON-RPC
// structuredContent must be an object — see
// templates/orchestrator's build-server usage of `readOnlyStructuredResult`).
// `runsList`, `spawnList`, and `v3RunNodes` are all `readOnly: true` and all
// return arrays, so their structuredContent ALWAYS arrives wrapped like this
// in production — yet `callOrchestratorTool` returned `result.structuredContent`
// verbatim, so callers doing `Array.isArray(data)` (get-activity.ts) always
// saw `false` and silently fell back to `[]`, even though real data existed.
//
// These tests exercise the REAL HTTP-response-parsing path (mocked fetch),
// not a mocked `callOrchestratorTool` module — the existing
// get-activity.test.ts mocks `callOrchestratorTool` itself, which is exactly
// why this parsing bug was never caught.
// ============================================================================

const ORIGINAL_ENV = { ...process.env };

function mcpEnvelope(structuredContent: unknown, textArray: unknown[]) {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: JSON.stringify(textArray) }],
      structuredContent,
    },
  };
}

beforeEach(() => {
  process.env.A2A_SECRET = "test-secret";
  process.env.ORCHESTRATOR_BASE_URL = "http://an-orchestrator:3002";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("callOrchestratorTool — structuredContent array unwrapping", () => {
  it("unwraps a readOnly array tool's { items: [...] } structuredContent back to a plain array", async () => {
    const nodes = [
      { id: "v3n_1", nodeIdInDag: "develop", status: "done", error: null },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify(mcpEnvelope({ items: nodes }, nodes)),
      }),
    );

    const { data } = await callOrchestratorTool(
      "sdlc-manager-1783064523@dogfood.local",
      "v3RunNodes",
      { runId: "v3r_dphm6fmgx62x0mhi" },
    );

    expect(Array.isArray(data)).toBe(true);
    expect(data).toEqual(nodes);
  });

  it("unwraps runsList's wrapped array the same way", async () => {
    const runs = [
      {
        id: "v3r_dphm6fmgx62x0mhi",
        status: "done",
        tags: { source: "tracker", item_id: "ihil7x6hjo" },
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify(mcpEnvelope({ items: runs }, runs)),
      }),
    );

    const { data } = await callOrchestratorTool(
      "sdlc-manager-1783064523@dogfood.local",
      "runsList",
      { tagMatch: { source: "tracker", item_id: "ihil7x6hjo" }, limit: 50 },
    );

    expect(Array.isArray(data)).toBe(true);
    expect((data as unknown[]).length).toBe(1);
  });

  it("passes through an object-shaped structuredContent unchanged (e.g. brain-thread)", async () => {
    const threadPayload = {
      thread: { id: "bt_1", status: "done" },
      events: [{ id: "be_1", seq: 0, type: "user", text: "hi" }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [{ type: "text", text: JSON.stringify(threadPayload) }],
              structuredContent: threadPayload,
            },
          }),
      }),
    );

    const { data } = await callOrchestratorTool(
      "owner@example.com",
      "brain-thread",
      { threadId: "bt_1" },
    );

    expect(data).toEqual(threadPayload);
  });

  it("does not unwrap a legitimate multi-key object that happens to have an items array field", async () => {
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

    const { data } = await callOrchestratorTool(
      "owner@example.com",
      "some-paginated-tool",
      {},
    );

    expect(data).toEqual(payload);
  });

  it("still falls back to parsing content[0].text when structuredContent is absent", async () => {
    const runs = [{ id: "v3r_x", status: "done" }];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [{ type: "text", text: JSON.stringify(runs) }],
            },
          }),
      }),
    );

    const { data } = await callOrchestratorTool(
      "owner@example.com",
      "runsList",
      {},
    );

    expect(Array.isArray(data)).toBe(true);
    expect(data).toEqual(runs);
  });
});
