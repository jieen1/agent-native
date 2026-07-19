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
  const state = { events: [] as Array<Record<string, unknown>> };

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
const mockGenerateText = vi.fn(async (..._args: unknown[]) => ({
  text: "ok",
  toolCalls: [],
  finishReason: "stop",
}));

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => mockGenerateText(...args),
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
  const body = JSON.parse(init.body) as { method: string };
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
  throw new Error(`unexpected fetch call in test: ${body.method}`);
});

import { runSdkBrainTurn } from "./sdk-brain-session.js";

describe("runSdkBrainTurn — runtimeOverride", () => {
  beforeEach(() => {
    hoisted.state.events.length = 0;
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
    // (VLLM_BASE_URL/VLLM_MODEL/VLLM_API_KEY) — no OPENAI_* env vars are set
    // in this test process, so the hardcoded defaults apply unchanged.
    expect(openaiCalls).toEqual([
      { apiKey: "sk-vllm-local", baseURL: "http://192.168.1.250:9000/v1" },
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

  it("a runtimeOverride missing an apiKey falls back to the local placeholder key (VllmExecutorConfig's own tolerance)", async () => {
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

    expect(openaiCalls).toEqual([
      { apiKey: "sk-vllm-local", baseURL: "http://localhost:8000/v1" },
    ]);
  });
});
