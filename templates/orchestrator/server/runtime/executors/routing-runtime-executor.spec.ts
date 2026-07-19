import { describe, it, expect, vi } from "vitest";

import {
  RoutingRuntimeExecutor,
  selectRuntimeRoute,
  type OwnerRuntimeRow,
} from "./routing-runtime-executor.js";
import type {
  RuntimeExecCtx,
  RuntimeExecResult,
  RuntimeExecutor,
} from "./types.js";

// Wires the real, saved runtime_configs table into V3's EXECUTE stage
// (see routing-runtime-executor.ts's header comment for the full design).
// These tests cover exactly the task's three guarantees:
//   1. a node routes to an ACTIVE runtime_configs row when one exists,
//   2. it falls back to the pre-existing RemoteApiExecutor behavior when
//      nothing is configured/active (backward compatibility),
//   3. claude-code is never resolved through this router at all.

const aliyunRow: OwnerRuntimeRow = {
  id: "rt_aliyun123",
  name: "Aliyun Bailian",
  kind: "openai-compatible",
  baseUrl: "https://llm-odw71g832ubo775e.cn-beijing.maas.aliyuncs.com/v1",
  model: "qwen-plus",
  active: 1,
};

const inactiveVllmRow: OwnerRuntimeRow = {
  id: "rt_localvllm",
  name: "Local vLLM",
  kind: "vllm",
  baseUrl: "http://localhost:8000/v1",
  model: "qwen3.6",
  active: 0,
};

const activeClaudeCodeRow: OwnerRuntimeRow = {
  id: "rt_cc",
  name: "Claude Code",
  kind: "claude-code",
  baseUrl: null,
  model: null,
  active: 1,
};

describe("selectRuntimeRoute (pure decision)", () => {
  it("routes the generic 'vllm' engine placeholder to the ACTIVE non-claude-code row", () => {
    const row = selectRuntimeRoute({ engine: "vllm" }, [
      inactiveVllmRow,
      aliyunRow,
    ]);
    expect(row).toEqual(aliyunRow);
  });

  it("routes an empty/unset engine to the active row too (no explicit choice)", () => {
    expect(selectRuntimeRoute({}, [aliyunRow])).toEqual(aliyunRow);
    expect(selectRuntimeRoute({ engine: "" }, [aliyunRow])).toEqual(aliyunRow);
  });

  it("falls back to undefined when NO row is active (preserves default vLLM-env-var behavior)", () => {
    expect(
      selectRuntimeRoute({ engine: "vllm" }, [inactiveVllmRow]),
    ).toBeUndefined();
    expect(selectRuntimeRoute({ engine: "vllm" }, [])).toBeUndefined();
  });

  it("an explicit per-node reference to a specific row id wins even when a DIFFERENT row is active", () => {
    const row = selectRuntimeRoute({ engine: "rt_localvllm" }, [
      inactiveVllmRow,
      aliyunRow,
    ]);
    expect(row).toEqual(inactiveVllmRow);
  });

  it("a real built-in framework engine id (e.g. implementer.md's ai-sdk:openai) never routes to a runtime_configs row", () => {
    expect(
      selectRuntimeRoute({ engine: "ai-sdk:openai" }, [aliyunRow]),
    ).toBeUndefined();
    expect(
      selectRuntimeRoute({ engine: "ai-sdk:anthropic" }, [aliyunRow]),
    ).toBeUndefined();
  });

  it("never resolves a claude-code-kind row, even via an explicit id match or as the 'active' row", () => {
    expect(
      selectRuntimeRoute({ engine: "rt_cc" }, [activeClaudeCodeRow]),
    ).toBeUndefined();
    expect(
      selectRuntimeRoute({ engine: "vllm" }, [activeClaudeCodeRow]),
    ).toBeUndefined();
    // Mixed: an active claude-code row must not shadow a real active vllm row
    // being absent — still undefined (no non-CC row is active here).
    expect(
      selectRuntimeRoute({ engine: "vllm" }, [
        activeClaudeCodeRow,
        inactiveVllmRow,
      ]),
    ).toBeUndefined();
  });
});

function fakeCtx(
  engine: string | undefined,
  ownerEmail = "owner@example.com",
): RuntimeExecCtx {
  return {
    node: { id: "n1", type: "agent", title: "n1", engine },
    ownerEmail,
    orgId: null,
    deps: {},
    signal: new AbortController().signal,
  } as unknown as RuntimeExecCtx;
}

const okResult: RuntimeExecResult = {
  output: { text: "ok" },
  tokensSpent: 10,
  toolCallCount: 0,
  model: "test-model",
};

describe("RoutingRuntimeExecutor.run (glue, dependency-injected)", () => {
  it("routes to VllmExecutor with the active row's baseUrl/model/apiKey when one exists", async () => {
    const vllmRun = vi.fn(async () => okResult);
    const remoteApiRun = vi.fn(async () => okResult);
    const executor = new RoutingRuntimeExecutor({
      loadRows: async () => [inactiveVllmRow, aliyunRow],
      resolveApiKey: async (row) =>
        row.id === aliyunRow.id ? "sk-real-aliyun-key" : undefined,
      vllmFor: (cfg) => {
        expect(cfg).toEqual({
          baseUrl: aliyunRow.baseUrl,
          model: aliyunRow.model,
          apiKey: "sk-real-aliyun-key",
        });
        return { kind: "vllm", run: vllmRun } satisfies RuntimeExecutor;
      },
      remoteApi: { kind: "remote-api", run: remoteApiRun },
    });

    const result = await executor.run(fakeCtx("vllm"));

    expect(result).toBe(okResult);
    expect(vllmRun).toHaveBeenCalledTimes(1);
    expect(remoteApiRun).not.toHaveBeenCalled();
  });

  it("falls back to RemoteApiExecutor, UNCHANGED, when no runtime_configs row is active/configured", async () => {
    const vllmFor = vi.fn();
    const remoteApiRun = vi.fn(async () => okResult);
    const executor = new RoutingRuntimeExecutor({
      loadRows: async () => [inactiveVllmRow],
      vllmFor,
      remoteApi: { kind: "remote-api", run: remoteApiRun },
    });

    const ctx = fakeCtx("vllm");
    const result = await executor.run(ctx);

    expect(result).toBe(okResult);
    expect(remoteApiRun).toHaveBeenCalledWith(ctx);
    expect(vllmFor).not.toHaveBeenCalled();
  });

  it("falls back to RemoteApiExecutor when the owner has zero runtime_configs rows at all", async () => {
    const remoteApiRun = vi.fn(async () => okResult);
    const executor = new RoutingRuntimeExecutor({
      loadRows: async () => [],
      remoteApi: { kind: "remote-api", run: remoteApiRun },
    });

    await executor.run(fakeCtx("vllm"));
    expect(remoteApiRun).toHaveBeenCalledTimes(1);
  });

  it("a real built-in engine id (implementer.md) still goes straight to RemoteApiExecutor even with an active row", async () => {
    const vllmFor = vi.fn();
    const remoteApiRun = vi.fn(async () => okResult);
    const executor = new RoutingRuntimeExecutor({
      loadRows: async () => [aliyunRow],
      vllmFor,
      remoteApi: { kind: "remote-api", run: remoteApiRun },
    });

    await executor.run(fakeCtx("ai-sdk:openai"));
    expect(remoteApiRun).toHaveBeenCalledTimes(1);
    expect(vllmFor).not.toHaveBeenCalled();
  });

  it("claude-code is never resolved through this router — it is not a reachable route at all", async () => {
    const vllmFor = vi.fn();
    const remoteApiRun = vi.fn(async () => okResult);
    const executor = new RoutingRuntimeExecutor({
      // Even if a claude-code-kind row were somehow present/active, the pure
      // selector excludes it — this asserts the router itself has no path to
      // ever hand a claude-code node to VllmExecutor. In production,
      // v3-dispatcher.ts's isClaudeCodeRuntime() branch never calls this
      // executor at all for a claude-code node (see v3-dispatcher.ts spawn()).
      loadRows: async () => [activeClaudeCodeRow],
      vllmFor,
      remoteApi: { kind: "remote-api", run: remoteApiRun },
    });

    await executor.run(fakeCtx("claude-code"));
    expect(vllmFor).not.toHaveBeenCalled();
    expect(remoteApiRun).toHaveBeenCalledTimes(1);
  });

  it("skips the runtime_configs lookup entirely when ctx.ownerEmail is empty (no owner to scope to)", async () => {
    const loadRows = vi.fn(async () => [aliyunRow]);
    const remoteApiRun = vi.fn(async () => okResult);
    const executor = new RoutingRuntimeExecutor({
      loadRows,
      remoteApi: { kind: "remote-api", run: remoteApiRun },
    });

    await executor.run(fakeCtx("vllm", ""));
    expect(loadRows).not.toHaveBeenCalled();
    expect(remoteApiRun).toHaveBeenCalledTimes(1);
  });

  it("a loadRows failure degrades to the RemoteApiExecutor fallback rather than throwing", async () => {
    const remoteApiRun = vi.fn(async () => okResult);
    const executor = new RoutingRuntimeExecutor({
      loadRows: async () => {
        throw new Error("db unavailable");
      },
      remoteApi: { kind: "remote-api", run: remoteApiRun },
    });

    const result = await executor.run(fakeCtx("vllm"));
    expect(result).toBe(okResult);
    expect(remoteApiRun).toHaveBeenCalledTimes(1);
  });

  it("an apiKey resolution failure still routes to VllmExecutor, with apiKey undefined (VllmExecutor's own placeholder applies)", async () => {
    const vllmRun = vi.fn(async () => okResult);
    const executor = new RoutingRuntimeExecutor({
      loadRows: async () => [aliyunRow],
      resolveApiKey: async () => {
        throw new Error("secret read failed");
      },
      vllmFor: (cfg) => {
        expect(cfg.apiKey).toBeUndefined();
        return { kind: "vllm", run: vllmRun };
      },
    });

    await executor.run(fakeCtx("vllm"));
    expect(vllmRun).toHaveBeenCalledTimes(1);
  });
});
