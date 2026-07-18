import { describe, it, expect } from "vitest";

import type { RuntimeExecCtx } from "./types.js";
import { resolveModel, DEFAULT_VLLM_MODEL } from "./vllm-executor.js";

// Task #89 regression coverage: RoutingRuntimeExecutor correctly forwards a
// node to the right baseUrl+API key when routed to a real `runtime_configs`
// row (e.g. a user's "aliyun" remote provider), but previously did NOT align
// the requested MODEL NAME to that row's configured `model` — a node's
// agent-def static model (e.g. vllm's seeded "qwen3.6") always won unless the
// DAG node explicitly set a `model_override`, so a node routed to a remote
// provider that doesn't serve that model name got a silent, confusing
// failure (routing "succeeded" — right baseUrl, right key — but the remote
// API rejected the unknown model name).
//
// `resolveModel` is the fix: PURE — no IO, unit-testable in isolation
// (mirrors `selectRuntimeRoute` in routing-runtime-executor.ts).

function fakeCtx(node: {
  model?: string;
  modelOverride?: string;
}): RuntimeExecCtx {
  return {
    node: { id: "n1", type: "agent", title: "n1", ...node },
    ownerEmail: "owner@example.com",
    orgId: null,
    deps: {},
    signal: new AbortController().signal,
  } as unknown as RuntimeExecCtx;
}

describe("resolveModel (task #89: align requested model to the routed runtime_configs row)", () => {
  it("no model_override, routed to a runtime_configs row → uses the ROW's configured model, not the agent-def's static one", () => {
    const ctx = fakeCtx({ model: "qwen3.6" }); // agent-def static default (vllm.md)
    const model = resolveModel(ctx, {
      baseUrl: "https://llm-odw71g832ubo775e.cn-beijing.maas.aliyuncs.com/v1",
      model: "qwen-plus", // the aliyun row's own configured model
      apiKey: "sk-real-aliyun-key",
    });
    expect(model).toBe("qwen-plus");
    expect(model).not.toBe("qwen3.6");
  });

  it("an explicit model_override still wins even when routed to a runtime_configs row", () => {
    const ctx = fakeCtx({
      model: "qwen3.6", // flattened agent-def default (v3-dispatcher.ts)
      modelOverride: "qwen-max", // the DAG author's deliberate per-node choice
    });
    const model = resolveModel(ctx, {
      baseUrl: "https://llm-odw71g832ubo775e.cn-beijing.maas.aliyuncs.com/v1",
      model: "qwen-plus", // the row's own model — override still beats this
      apiKey: "sk-real-aliyun-key",
    });
    expect(model).toBe("qwen-max");
  });

  it("no runtime_configs row involved (fallback path) → unchanged: uses the agent-def's static model", () => {
    const ctx = fakeCtx({ model: "qwen3.6" });
    // cfg undefined: RoutingRuntimeExecutor found no matching/active row, so
    // VllmExecutor (when reached at all) sees no row config here — same
    // shape as before this fix.
    expect(resolveModel(ctx, undefined)).toBe("qwen3.6");
  });

  it("no override, no row, no node.model at all → last-resort DEFAULT_VLLM_MODEL", () => {
    expect(resolveModel(fakeCtx({}), undefined)).toBe(DEFAULT_VLLM_MODEL);
  });

  it("no override, row matched but the row itself has no model configured → falls back to node.model", () => {
    const ctx = fakeCtx({ model: "qwen3.6" });
    expect(
      resolveModel(ctx, { baseUrl: "http://localhost:8000/v1", model: null }),
    ).toBe("qwen3.6");
  });

  it("a blank-string model_override is treated as unset (falls through to the row's model)", () => {
    const ctx = fakeCtx({ model: "qwen3.6", modelOverride: "   " });
    expect(resolveModel(ctx, { model: "qwen-plus" })).toBe("qwen-plus");
  });
});
