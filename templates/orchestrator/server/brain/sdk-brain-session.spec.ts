// Brain runtime-switching (additive feature) — runSdkBrainTurn's new
// `runtimeOverride` option. Proves TWO things:
//   1. a supplied runtimeOverride's baseUrl/model/apiKey actually reach the
//      createOpenAI(...)/openai(model) call sites, replacing the module-level
//      env-var-derived VLLM_BASE_URL/VLLM_MODEL/VLLM_API_KEY constants;
//   2. omitting it preserves the EXACT existing env-var-derived defaults,
//      byte for byte — this is the automatic CC-logged-out fallback path and
//      must see zero behavior change from this feature.
//
// db (brain_events), the MCP fetch round-trip, and the dynamically-imported
// "ai" / "@ai-sdk/openai" packages are all mocked — no live DB, no network,
// no real model call.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const hoisted = vi.hoisted(() => {
  // A distinguishable fake "real secret" so a runtimeOverride test can prove
  // this value is NEVER used for an override's endpoint, rather than merely
  // coinciding with the placeholder because no env var happened to be set.
  // Set via vi.hoisted (runs before the static `import` below resolves) since
  // VLLM_API_KEY is a module-level const computed from process.env at import
  // time — a plain top-of-file assignment would run too late to affect it.
  process.env.OPENAI_API_KEY = "sk-should-never-leak-to-a-runtime-override";

  const state = {
    events: [] as Array<Record<string, unknown>>,
    updates: [] as Array<Record<string, unknown>>,
  };

  function priorEventsChain(rows: unknown[]) {
    const chain = {
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
        Promise.resolve(rows).then(resolve, reject),
      orderBy: () => chain,
    };
    return chain;
  }

  return {
    state,
    makeDb: () => ({
      select: (selection?: Record<string, unknown>) => ({
        from: () => ({
          where: () => {
            // appendEvent's next-seq query selects `{ next: <sql> }`;
            // the prior-conversation read calls `.select()` with no columns.
            if (selection && "next" in selection) {
              return Promise.resolve([{ next: state.events.length }]);
            }
            return priorEventsChain([...state.events]);
          },
        }),
      }),
      insert: () => ({
        values: (row: Record<string, unknown>) => {
          state.events.push(row);
          return Promise.resolve();
        },
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          state.updates.push(values as Record<string, unknown>);
          return { where: () => Promise.resolve() };
        },
      }),
    }),
  };
});

vi.mock("../db/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/index.js")>();
  return { ...actual, getV3Db: () => hoisted.makeDb() };
});

vi.mock("./brain-mcp-config.js", () => ({
  mintBrainToken: vi.fn(() => "test-bearer-token"),
}));

const openaiCalls: Array<{ apiKey: string; baseURL: string }> = [];
const openaiModelCalls: string[] = [];
interface MockGenerateTextResult {
  text: string;
  toolCalls: unknown[];
  finishReason: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}
const mockGenerateText = vi.fn(
  async (..._args: unknown[]): Promise<MockGenerateTextResult> => ({
    text: "ok",
    toolCalls: [],
    finishReason: "stop",
  }),
);

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => mockGenerateText(...args),
  // Mirrors the real `ai` package's marker-wrapped Schema<T> shape closely
  // enough to prove `sdk-brain-session.ts` actually calls `jsonSchema()`
  // (rather than silently passing the raw object through, which throws
  // "... is not a function" against the real `asSchema()`).
  jsonSchema: (schema: Record<string, unknown>) => ({
    __wrappedJsonSchema: true,
    jsonSchema: schema,
  }),
}));
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: (opts: { apiKey: string; baseURL: string }) => {
    openaiCalls.push(opts);
    return (model: string) => {
      openaiModelCalls.push(model);
      return { __model: model };
    };
  },
}));

const mockFetch = vi.fn(async (_url: string, init: { body: string }) => {
  const body = JSON.parse(init.body) as {
    method: string;
    params?: { name?: string };
  };
  if (body.method === "tools/list") {
    return {
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({
        result: {
          tools: [{ name: "noop", description: "no-op", inputSchema: {} }],
        },
      }),
    } as unknown as Response;
  }
  // A real tool/call against a KNOWN tool (used by the must-not-regress happy
  // path test below) — generic success payload naming the tool that was
  // actually called.
  if (body.method === "tools/call") {
    return {
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: true, tool: body.params?.name }),
            },
          ],
        },
      }),
    } as unknown as Response;
  }
  throw new Error(`unexpected fetch call in test: ${body.method}`);
});

import { runSdkBrainTurn, unknownToolMessage } from "./sdk-brain-session.js";

describe("runSdkBrainTurn — runtimeOverride", () => {
  beforeEach(() => {
    hoisted.state.events.length = 0;
    hoisted.state.updates.length = 0;
    openaiCalls.length = 0;
    openaiModelCalls.length = 0;
    mockGenerateText.mockClear();
    mockFetch.mockClear();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("omitting runtimeOverride preserves the EXACT existing env-var-derived defaults", async () => {
    const result = await runSdkBrainTurn({
      threadId: "thread-1",
      ownerEmail: "owner@example.com",
      orgId: null,
      message: "hello",
    });

    expect(result).toEqual({ ok: true });
    // These mirror sdk-brain-session.ts's own module-level fallback constants
    // (VLLM_BASE_URL/VLLM_MODEL/VLLM_API_KEY) — the real (fake-for-this-test)
    // OPENAI_API_KEY env secret IS expected here: this is the unmodified,
    // pre-existing automatic-fallback path, which has always used it.
    expect(openaiCalls).toEqual([
      {
        apiKey: "sk-should-never-leak-to-a-runtime-override",
        baseURL: "http://192.168.1.250:9000/v1",
      },
    ]);
    expect(openaiModelCalls).toEqual(["claude-sonnet-4-6"]);

    const systemEvent = hoisted.state.events.find((e) => e.type === "system");
    expect(systemEvent?.text).toContain("SDK brain (vLLM)");
    expect(systemEvent?.text).toContain("claude-sonnet-4-6");
    expect(systemEvent?.text).toContain("http://192.168.1.250:9000/v1");
  });

  it("a supplied runtimeOverride's baseUrl/model/apiKey reach createOpenAI/openai(model), overriding the defaults", async () => {
    const result = await runSdkBrainTurn({
      threadId: "thread-2",
      ownerEmail: "owner@example.com",
      orgId: null,
      message: "hello",
      runtimeOverride: {
        baseUrl:
          "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        model: "qwen3.8-max-preview",
        apiKey: "sk-real-aliyun-key",
        name: "Aliyun Bailian",
      },
    });

    expect(result).toEqual({ ok: true });
    expect(openaiCalls).toEqual([
      {
        apiKey: "sk-real-aliyun-key",
        baseURL:
          "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      },
    ]);
    expect(openaiModelCalls).toEqual(["qwen3.8-max-preview"]);

    const systemEvent = hoisted.state.events.find((e) => e.type === "system");
    expect(systemEvent?.text).toContain("runtime override");
    expect(systemEvent?.text).toContain("Aliyun Bailian");
    expect(systemEvent?.text).toContain("qwen3.8-max-preview");
    expect(systemEvent?.text).toContain(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    );
  });

  it("a runtimeOverride missing an apiKey falls back to a fake placeholder, NEVER to the host's real OPENAI_API_KEY env secret", async () => {
    await runSdkBrainTurn({
      threadId: "thread-3",
      ownerEmail: "owner@example.com",
      orgId: null,
      message: "hello",
      runtimeOverride: {
        baseUrl: "http://localhost:8000/v1",
        model: "qwen3.6",
      },
    });

    // The real assertion: whatever key was used, it must NOT be the (fake,
    // for this test) "real" OPENAI_API_KEY secret — an override's endpoint is
    // user-supplied and must never receive the host's real credential.
    expect(openaiCalls[0]?.apiKey).not.toBe(
      "sk-should-never-leak-to-a-runtime-override",
    );
    expect(openaiCalls).toEqual([
      { apiKey: "sk-vllm-local", baseURL: "http://localhost:8000/v1" },
    ]);
  });

  it("passes each MCP tool's schema to generateText as a jsonSchema()-wrapped `inputSchema`, not the stale v4/v5 `parameters` key", async () => {
    // Regression test for a real production failure: AI SDK v6's `Tool` type
    // reads `inputSchema`. Building the tools record with `parameters:
    // t.inputSchema` (the old v4/v5 field name) left every tool's real
    // `inputSchema` undefined; `asSchema()` then silently substituted its own
    // bare default for every tool regardless of what the MCP endpoint served,
    // which is what actually broke tool-calling against a strict
    // OpenAI-compatible endpoint (Aliyun/DashScope) — not just `list_apps`.
    //
    // A raw JSON-Schema object isn't valid on its own either — `asSchema()`
    // calls anything that isn't a recognized Schema/Zod/Standard-Schema AS A
    // FUNCTION, throwing "... is not a function". This asserts
    // `jsonSchema()` (mocked above) actually wraps it, matching
    // `ai-sdk-engine.ts`'s `engineToolsToAISDK(tools, jsonSchema)` pattern.
    await runSdkBrainTurn({
      threadId: "thread-4",
      ownerEmail: "owner@example.com",
      orgId: null,
      message: "hello",
    });

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const passedTools = (
      mockGenerateText.mock.calls[0]?.[0] as { tools?: Record<string, any> }
    )?.tools;
    expect(passedTools).toEqual({
      noop: {
        description: "no-op",
        inputSchema: { __wrappedJsonSchema: true, jsonSchema: {} },
      },
    });
    expect(passedTools?.noop.parameters).toBeUndefined();
  });

  it("persists the resolved model + a derived context window to brain_threads for a runtimeOverride turn", async () => {
    // Regression test for the root cause: runSdkBrainTurn never wrote
    // `model`/`contextWindow` back to brain_threads, so the brain-usage
    // action's actualModel stayed NULL and fell back to the Claude-tier
    // DEFAULT_BRAIN_MODEL (1M window) for whatever model actually ran.
    const result = await runSdkBrainTurn({
      threadId: "thread-5",
      ownerEmail: "owner@example.com",
      orgId: null,
      message: "hello",
      runtimeOverride: {
        baseUrl:
          "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        model: "qwen3.8-max-preview",
        apiKey: "sk-real-aliyun-key",
        name: "Aliyun Bailian",
      },
    });

    expect(result).toEqual({ ok: true });

    const modelUpdate = hoisted.state.updates.find(
      (u) => u.model === "qwen3.8-max-preview",
    );
    expect(modelUpdate).toBeDefined();
    // "qwen3.8-max-preview" matches neither the opus/[1m] 1M regexes nor the
    // sonnet/haiku family regexes, so it lands on deriveContextWindow's
    // default of 200000 — a number, present, and NOT the Claude-tier 1M.
    expect(typeof modelUpdate?.contextWindow).toBe("number");
    expect(modelUpdate?.contextWindow).toBe(200000);
    expect(modelUpdate?.contextWindow).not.toBe(1000000);
  });

  it("persists the live context fill (contextUsed) from generateText's usage.inputTokens", async () => {
    // AI SDK v6's OpenAI-compatible usage.inputTokens is the TOTAL prompt/
    // context size for the call (already includes cached-read tokens), so it
    // is persisted directly as contextUsed without any cache subfield sum.
    mockGenerateText.mockResolvedValueOnce({
      text: "done",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 12345, outputTokens: 10, totalTokens: 12355 },
    });

    const result = await runSdkBrainTurn({
      threadId: "thread-6",
      ownerEmail: "owner@example.com",
      orgId: null,
      message: "hello",
    });

    expect(result).toEqual({ ok: true });
    expect(mockGenerateText).toHaveBeenCalledTimes(1);

    const usageUpdate = hoisted.state.updates.find(
      (u) => u.contextUsed === 12345,
    );
    expect(usageUpdate).toBeDefined();
  });

  describe("SDLC-066 — fabricated tool calls get corrective feedback, not a silent black hole", () => {
    it("unknownToolMessage names the real available tools and the missing-tool guidance, never the generic MCP wording", () => {
      const msg = unknownToolMessage("workspaceGet", [
        "noop",
        "workspaceCreate",
      ]);
      expect(msg).toContain('Tool "workspaceGet" does not exist');
      expect(msg).toContain("noop, workspaceCreate");
      expect(msg).toContain("workspaceCreate");
      expect(msg).not.toContain("Unknown tool");
    });

    it("a tool name not in the discovered set short-circuits BEFORE any MCP round-trip and reports the real tool set", async () => {
      // Real production data (2026-07-20/21, model=qwen3.8-max-preview via
      // the aliyun runtime override): the brain repeatedly tried real-looking
      // but uncataloged action names (workspaceGet, runCancel, nodeRetry,
      // spawnCancel, source-search) that reached mcpCallTool and got back
      // only the MCP server's generic "Unknown tool: X" — nothing telling it
      // what IS callable, so it sometimes needed several attempts (observed:
      // 3x identical runCancel retries in one thread) before self-correcting.
      // workspaceGet is used here as the still-uncataloged example (nodeRetry
      // /runCancel/spawnCancel are fixed at the catalog level by this same
      // change — see agent-chat.spec.ts).
      mockGenerateText
        .mockResolvedValueOnce({
          text: "",
          toolCalls: [
            { toolCallId: "tc_wsget", toolName: "workspaceGet", input: {} },
          ],
          finishReason: "tool-calls",
        })
        .mockResolvedValueOnce({
          text: "done",
          toolCalls: [],
          finishReason: "stop",
        });

      const result = await runSdkBrainTurn({
        threadId: "thread-9",
        ownerEmail: "owner@example.com",
        orgId: null,
        message: "hello",
      });

      expect(result).toEqual({ ok: true });
      expect(mockGenerateText).toHaveBeenCalledTimes(2);

      // Never round-tripped the fabricated name to the MCP endpoint — only
      // the initial tools/list call happened.
      const calledMethods = mockFetch.mock.calls.map(
        (c) =>
          (JSON.parse((c[1] as { body: string }).body) as { method: string })
            .method,
      );
      expect(calledMethods).toEqual(["tools/list"]);

      const toolResultEvent = hoisted.state.events.find(
        (e) => e.type === "tool_result" && e.toolName === "workspaceGet",
      );
      expect(toolResultEvent).toBeDefined();
      const toolResult = toolResultEvent?.toolResult as { error: string };
      expect(toolResult.error).toContain('Tool "workspaceGet" does not exist');
      expect(toolResult.error).toContain("noop");
      expect(toolResult.error).not.toContain("Unknown tool");
    });

    it("a real, known tool call still round-trips through the MCP endpoint unaffected (must-not-regress happy path)", async () => {
      // The currently-working "dispatch straight to a real tool, no
      // exploration needed" path must see zero behavior change from the
      // SDLC-066 fix — only a genuinely fabricated name should short-circuit.
      mockGenerateText
        .mockResolvedValueOnce({
          text: "",
          toolCalls: [{ toolCallId: "tc_noop", toolName: "noop", input: {} }],
          finishReason: "tool-calls",
        })
        .mockResolvedValueOnce({
          text: "done",
          toolCalls: [],
          finishReason: "stop",
        });

      const result = await runSdkBrainTurn({
        threadId: "thread-10",
        ownerEmail: "owner@example.com",
        orgId: null,
        message: "hello",
      });

      expect(result).toEqual({ ok: true });

      const calledMethods = mockFetch.mock.calls.map(
        (c) =>
          (JSON.parse((c[1] as { body: string }).body) as { method: string })
            .method,
      );
      expect(calledMethods).toEqual(["tools/list", "tools/call"]);

      const toolResultEvent = hoisted.state.events.find(
        (e) => e.type === "tool_result" && e.toolName === "noop",
      );
      expect(toolResultEvent?.toolResult).toEqual({ ok: true, tool: "noop" });
    });
  });
});
