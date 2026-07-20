// F2 executor context management (work item nv73eo2nbm — conclusion B) —
// engine-loop.ts wiring tests. Drives `runEngineLoopInVm` against a MOCK
// `runAgentLoopDirectWithSoftTimeout` (the framework wrapper the in-app chat
// run handler uses) that emits the same `send` events the real core loop would,
// so these specs exercise engine-loop.ts's OWN logic (threadId/owner wiring,
// the OM-injection trace, the size-triggered compaction, the soft-timeout
// passthrough, checkpoint persistence) without needing a live model, VM, or
// Postgres. Per the F2 test plan, the OM surface is driven through a mock + a
// small compaction-threshold env override, not a live 101 window.

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { RuntimeExecCtx, RuntimeExecStep } from "../types.js";

// ── Hoisted mocks (vi.mock factories run before imports) ───────────────────
const hoisted = vi.hoisted(() => ({
  runAgentLoopDirectWithSoftTimeout: vi.fn(),
  actionsToEngineTools: vi.fn((actions: Record<string, unknown>) =>
    Object.keys(actions).map((name) => ({
      name,
      description: "",
      inputSchema: { type: "object" as const },
    })),
  ),
  maybeCompactThread: vi.fn(),
  buildObservationalContext: vi.fn(),
  hasObservationalMemory: vi.fn(),
  persistContextCheckpoint: vi.fn(),
}));

vi.mock("@agent-native/core/server", () => ({
  runAgentLoopDirectWithSoftTimeout:
    hoisted.runAgentLoopDirectWithSoftTimeout,
  actionsToEngineTools: hoisted.actionsToEngineTools,
}));

vi.mock("@agent-native/core/agent/observational-memory", () => ({
  maybeCompactThread: hoisted.maybeCompactThread,
  buildObservationalContext: hoisted.buildObservationalContext,
  hasObservationalMemory: hoisted.hasObservationalMemory,
}));

vi.mock("../context-checkpoint.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../context-checkpoint.js")>();
  return {
    ...actual,
    persistContextCheckpoint: hoisted.persistContextCheckpoint,
  };
});

import {
  runEngineLoopInVm,
  stepsToEngineMessages,
  compactThresholdTokens,
  compactThresholdChars,
  devSoftTimeoutMs,
} from "../engine-loop.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<RuntimeExecCtx> = {}): RuntimeExecCtx {
  const base = {
    runtime: {
      fs: () => ({
        read: vi.fn(async () => ""),
        write: vi.fn(async () => undefined),
      }),
      exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    },
    vm: {},
    node: { id: "node-abc", type: "agent", title: "dev task" },
    workdir: "/work",
    deps: {},
    ownerEmail: "owner@example.com",
    orgId: "org-1",
    signal: new AbortController().signal,
    onStep: undefined,
  };
  return { ...base, ...overrides } as unknown as RuntimeExecCtx;
}

type SendFn = (event: Record<string, unknown>) => void;

function baseUsage(overrides: Record<string, unknown> = {}) {
  return {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    model: "m1",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ORCH_DEV_MAX_OUTPUT_TOKENS;
  delete process.env.ORCH_DEV_COMPACT_THRESHOLD_TOKENS;
  delete process.env.ORCH_DEV_SOFT_TIMEOUT_MS;
  hoisted.persistContextCheckpoint.mockResolvedValue(undefined);
  hoisted.maybeCompactThread.mockResolvedValue({ observer: {}, reflector: {} });
  // Default: no persisted OM yet (short thread) → no injection trace.
  hoisted.buildObservationalContext.mockResolvedValue({
    threadId: "t",
    reflections: [],
    observations: [],
    recentMessages: [],
  });
  hoisted.hasObservationalMemory.mockReturnValue(false);
});

// ── threadId / OM activation wiring (conclusion B ②) ────────────────────────

describe("threadId + ownerEmail/orgId wiring (conclusion B ②)", () => {
  it("passes threadId=spawn:<spawnId> plus ownerEmail/orgId into the framework loop", async () => {
    hoisted.runAgentLoopDirectWithSoftTimeout.mockResolvedValueOnce(baseUsage());
    const ctx = makeCtx({
      spawnId: "sp_123",
      node: { id: "node-xyz", type: "agent", title: "t" } as never,
    });

    await runEngineLoopInVm({
      ctx,
      engine: {} as never,
      model: "m1",
      kind: "vllm",
    });

    expect(hoisted.runAgentLoopDirectWithSoftTimeout).toHaveBeenCalledTimes(1);
    const callArgs = hoisted.runAgentLoopDirectWithSoftTimeout.mock.calls[0][0];
    expect(callArgs.threadId).toBe("spawn:sp_123");
    expect(callArgs.ownerEmail).toBe("owner@example.com");
    expect(callArgs.orgId).toBe("org-1");
  });

  it("falls back to spawn:<nodeId> when no spawnId is threaded through", async () => {
    hoisted.runAgentLoopDirectWithSoftTimeout.mockResolvedValueOnce(baseUsage());
    await runEngineLoopInVm({
      ctx: makeCtx({ node: { id: "node-a", type: "agent", title: "t" } as never }),
      engine: {} as never,
      model: "m1",
      kind: "vllm",
    });
    const callArgs = hoisted.runAgentLoopDirectWithSoftTimeout.mock.calls[0][0];
    expect(callArgs.threadId).toBe("spawn:node-a");
  });

  it("uses a distinct threadId per spawn id (no cross-spawn collision)", async () => {
    hoisted.runAgentLoopDirectWithSoftTimeout.mockResolvedValue(baseUsage());
    await runEngineLoopInVm({
      ctx: makeCtx({ spawnId: "sp_a" }),
      engine: {} as never,
      model: "m1",
      kind: "vllm",
    });
    await runEngineLoopInVm({
      ctx: makeCtx({ spawnId: "sp_b" }),
      engine: {} as never,
      model: "m1",
      kind: "vllm",
    });
    const threadIds = hoisted.runAgentLoopDirectWithSoftTimeout.mock.calls.map(
      (c) => c[0].threadId,
    );
    expect(threadIds).toEqual(["spawn:sp_a", "spawn:sp_b"]);
  });
});

// ── Outer wrapper = runAgentLoopDirectWithSoftTimeout (conclusion B ④) ──────

describe("outer wrapper soft-timeout passthrough (conclusion B ④)", () => {
  it("routes through runAgentLoopDirectWithSoftTimeout with a dev-shaped background budget (not 40s)", async () => {
    hoisted.runAgentLoopDirectWithSoftTimeout.mockResolvedValueOnce(baseUsage());
    await runEngineLoopInVm({
      ctx: makeCtx(),
      engine: {} as never,
      model: "m1",
      kind: "vllm",
    });
    const softTimeoutMs =
      hoisted.runAgentLoopDirectWithSoftTimeout.mock.calls[0][1];
    const timeoutOptions =
      hoisted.runAgentLoopDirectWithSoftTimeout.mock.calls[0][2];
    expect(softTimeoutMs).toBe(600_000);
    expect(softTimeoutMs).not.toBe(40_000);
    expect(timeoutOptions).toEqual({ backgroundFunction: true });
  });

  it("honors an ORCH_DEV_SOFT_TIMEOUT_MS override (0 disables the wrapper)", async () => {
    process.env.ORCH_DEV_SOFT_TIMEOUT_MS = "0";
    hoisted.runAgentLoopDirectWithSoftTimeout.mockResolvedValueOnce(baseUsage());
    await runEngineLoopInVm({
      ctx: makeCtx(),
      engine: {} as never,
      model: "m1",
      kind: "vllm",
    });
    expect(hoisted.runAgentLoopDirectWithSoftTimeout.mock.calls[0][1]).toBe(0);
  });
});

// ── devMaxOutputTokens (T-F2-08) ─────────────────────────────────────────────

describe("devMaxOutputTokens (T-F2-08 — 32k regression)", () => {
  it("defaults maxOutputTokens to 32000", async () => {
    hoisted.runAgentLoopDirectWithSoftTimeout.mockResolvedValueOnce(baseUsage());
    await runEngineLoopInVm({
      ctx: makeCtx(),
      engine: {} as never,
      model: "m1",
      kind: "vllm",
    });
    expect(
      hoisted.runAgentLoopDirectWithSoftTimeout.mock.calls[0][0].maxOutputTokens,
    ).toBe(32_000);
  });

  it("respects an ORCH_DEV_MAX_OUTPUT_TOKENS override", async () => {
    process.env.ORCH_DEV_MAX_OUTPUT_TOKENS = "16000";
    hoisted.runAgentLoopDirectWithSoftTimeout.mockResolvedValueOnce(baseUsage());
    await runEngineLoopInVm({
      ctx: makeCtx(),
      engine: {} as never,
      model: "m1",
      kind: "vllm",
    });
    expect(
      hoisted.runAgentLoopDirectWithSoftTimeout.mock.calls[0][0].maxOutputTokens,
    ).toBe(16_000);
  });

  it("never reverts to the old 200000 hardcode regardless of override", async () => {
    process.env.ORCH_DEV_MAX_OUTPUT_TOKENS = "not-a-number";
    hoisted.runAgentLoopDirectWithSoftTimeout.mockResolvedValueOnce(baseUsage());
    await runEngineLoopInVm({
      ctx: makeCtx(),
      engine: {} as never,
      model: "m1",
      kind: "vllm",
    });
    expect(
      hoisted.runAgentLoopDirectWithSoftTimeout.mock.calls[0][0].maxOutputTokens,
    ).toBe(32_000);
  });
});

// ── OM-injection trace (conclusion B ⑤) ─────────────────────────────────────

describe("OM-injection trace in spawn_events (conclusion B ⑤)", () => {
  it("emits a visible [observational-memory] step when the thread already has OM", async () => {
    hoisted.buildObservationalContext.mockResolvedValueOnce({
      threadId: "spawn:sp_om",
      reflections: [{ text: "r1" }],
      observations: [{ text: "o1" }, { text: "o2" }],
      recentMessages: [],
    });
    hoisted.hasObservationalMemory.mockReturnValueOnce(true);
    hoisted.runAgentLoopDirectWithSoftTimeout.mockResolvedValueOnce(baseUsage());

    const result = await runEngineLoopInVm({
      ctx: makeCtx({ spawnId: "sp_om" }),
      engine: {} as never,
      model: "m1",
      kind: "vllm",
    });

    const omStep = (result.steps ?? []).find(
      (s) => s.type === "text" && s.text?.includes("[observational-memory]"),
    );
    expect(omStep).toBeDefined();
    expect(omStep?.text).toContain("spawn:sp_om");
    expect(omStep?.text).toContain("2 observation(s)");
    expect(omStep?.text).toContain("1 reflection(s)");
  });

  it("does not emit the OM trace for a short thread with no OM", async () => {
    hoisted.runAgentLoopDirectWithSoftTimeout.mockResolvedValueOnce(baseUsage());
    const result = await runEngineLoopInVm({
      ctx: makeCtx(),
      engine: {} as never,
      model: "m1",
      kind: "vllm",
    });
    const omStep = (result.steps ?? []).find(
      (s) => s.type === "text" && s.text?.includes("[observational-memory]"),
    );
    expect(omStep).toBeUndefined();
  });

  it("skips the OM read entirely for an anonymous (no-owner) run", async () => {
    hoisted.runAgentLoopDirectWithSoftTimeout.mockResolvedValueOnce(baseUsage());
    await runEngineLoopInVm({
      ctx: makeCtx({ ownerEmail: "" }),
      engine: {} as never,
      model: "m1",
      kind: "vllm",
    });
    expect(hoisted.buildObservationalContext).not.toHaveBeenCalled();
  });
});

// ── Compaction threshold trigger (T-F2-02 / conclusion B ③) ─────────────────

describe("compaction threshold trigger (conclusion B ③)", () => {
  it("triggers maybeCompactThread exactly once after crossing the char threshold", async () => {
    process.env.ORCH_DEV_COMPACT_THRESHOLD_TOKENS = "10"; // threshold = 40 chars
    hoisted.runAgentLoopDirectWithSoftTimeout.mockImplementationOnce(
      async (opts: { send: SendFn }) => {
        opts.send({ type: "tool_start", tool: "bash", input: {} });
        opts.send({ type: "tool_done", tool: "bash", result: "x".repeat(20) }); // 20 < 40
        opts.send({ type: "tool_start", tool: "bash", input: {} });
        opts.send({ type: "tool_done", tool: "bash", result: "y".repeat(30) }); // 50 > 40 -> fires once
        opts.send({ type: "tool_start", tool: "bash", input: {} });
        opts.send({ type: "tool_done", tool: "bash", result: "z".repeat(30) }); // stays fired-once
        return baseUsage();
      },
    );

    const result = await runEngineLoopInVm({
      ctx: makeCtx(),
      engine: {} as never,
      model: "m1",
      kind: "vllm",
    });

    expect(hoisted.maybeCompactThread).toHaveBeenCalledTimes(1);
    const compactedMarker = (result.steps ?? []).some(
      (s) => s.type === "text" && s.text?.includes("[context.compacted]"),
    );
    expect(compactedMarker).toBe(true);
  });

  it("does not trigger maybeCompactThread while under threshold", async () => {
    process.env.ORCH_DEV_COMPACT_THRESHOLD_TOKENS = "1000"; // threshold = 4000 chars
    hoisted.runAgentLoopDirectWithSoftTimeout.mockImplementationOnce(
      async (opts: { send: SendFn }) => {
        opts.send({ type: "tool_start", tool: "bash", input: {} });
        opts.send({ type: "tool_done", tool: "bash", result: "short" });
        return baseUsage();
      },
    );

    await runEngineLoopInVm({
      ctx: makeCtx(),
      engine: {} as never,
      model: "m1",
      kind: "vllm",
    });

    expect(hoisted.maybeCompactThread).not.toHaveBeenCalled();
  });

  it("passes threadId + owner + a reconstructed (non-empty) transcript to maybeCompactThread", async () => {
    process.env.ORCH_DEV_COMPACT_THRESHOLD_TOKENS = "1";
    hoisted.runAgentLoopDirectWithSoftTimeout.mockImplementationOnce(
      async (opts: { send: SendFn }) => {
        opts.send({ type: "tool_start", tool: "bash", input: { command: "ls" } });
        opts.send({ type: "tool_done", tool: "bash", result: "a.ts\nb.ts" });
        return baseUsage();
      },
    );

    await runEngineLoopInVm({
      ctx: makeCtx({ spawnId: "sp_c" }),
      engine: {} as never,
      model: "m1",
      kind: "vllm",
    });

    expect(hoisted.maybeCompactThread).toHaveBeenCalledTimes(1);
    const call = hoisted.maybeCompactThread.mock.calls[0][0];
    expect(call.threadId).toBe("spawn:sp_c");
    expect(call.ownerEmail).toBe("owner@example.com");
    expect(Array.isArray(call.messages)).toBe(true);
    expect(call.messages.length).toBeGreaterThan(0);
  });
});

// ── Compaction failure is fire-and-forget (T-F2-13) ─────────────────────────

describe("compaction failure never breaks the run (T-F2-13)", () => {
  it("swallows a maybeCompactThread rejection and completes normally", async () => {
    process.env.ORCH_DEV_COMPACT_THRESHOLD_TOKENS = "1";
    hoisted.maybeCompactThread.mockRejectedValueOnce(new Error("compaction boom"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    hoisted.runAgentLoopDirectWithSoftTimeout.mockImplementationOnce(
      async (opts: { send: SendFn }) => {
        opts.send({ type: "tool_start", tool: "bash", input: {} });
        opts.send({ type: "tool_done", tool: "bash", result: "x".repeat(50) });
        return baseUsage();
      },
    );

    const result = await runEngineLoopInVm({
      ctx: makeCtx(),
      engine: {} as never,
      model: "m1",
      kind: "vllm",
    });

    // Let the fire-and-forget rejection's .catch() settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.toolCallCount).toBe(1);
    warnSpy.mockRestore();
  });
});

// ── Checkpoint persists on success (T-F2-07) ────────────────────────────────

describe("checkpoint persistence on success (T-F2-07)", () => {
  it("persists a checkpoint after a normal successful completion", async () => {
    hoisted.runAgentLoopDirectWithSoftTimeout.mockImplementationOnce(
      async (opts: { send: SendFn }) => {
        opts.send({ type: "tool_start", tool: "write", input: { filePath: "a.ts" } });
        opts.send({ type: "tool_done", tool: "write", result: "Wrote a.ts (1 line)." });
        opts.send({ type: "text", text: "Done." });
        return baseUsage();
      },
    );

    await runEngineLoopInVm({
      ctx: makeCtx(),
      engine: {} as never,
      model: "m1",
      kind: "vllm",
    });

    expect(hoisted.persistContextCheckpoint).toHaveBeenCalledTimes(1);
    const persisted = hoisted.persistContextCheckpoint.mock.calls[0][0];
    expect(persisted.checkpoint.writtenFiles).toEqual(["a.ts"]);
  });
});

// ── Pure helper unit tests ──────────────────────────────────────────────────

describe("stepsToEngineMessages", () => {
  it("reconstructs an alternating user/assistant/user transcript", () => {
    const steps: RuntimeExecStep[] = [
      { seq: 0, type: "text", text: "thinking" },
      { seq: 1, type: "tool_use", name: "bash", input: { command: "ls" } },
      { seq: 2, type: "tool_result", name: "bash", result: "a.ts" },
      { seq: 3, type: "text", text: "done" },
    ];
    const messages = stepsToEngineMessages("do the task", steps);
    expect(messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "do the task" }],
    });
    expect(messages[1].role).toBe("assistant");
    expect(messages[2].role).toBe("user");
    expect(messages[3].role).toBe("assistant");
  });
});

describe("compactThresholdTokens / compactThresholdChars", () => {
  it("defaults to 70000 tokens / 280000 chars", () => {
    expect(compactThresholdTokens()).toBe(70_000);
    expect(compactThresholdChars()).toBe(280_000);
  });

  it("honors an env override", () => {
    process.env.ORCH_DEV_COMPACT_THRESHOLD_TOKENS = "100";
    expect(compactThresholdTokens()).toBe(100);
    expect(compactThresholdChars()).toBe(400);
  });
});

describe("devSoftTimeoutMs", () => {
  it("defaults to a 10-minute background budget (not the 40s chat wall)", () => {
    expect(devSoftTimeoutMs()).toBe(600_000);
  });

  it("honors an env override including 0 (wrapper disabled)", () => {
    process.env.ORCH_DEV_SOFT_TIMEOUT_MS = "0";
    expect(devSoftTimeoutMs()).toBe(0);
    process.env.ORCH_DEV_SOFT_TIMEOUT_MS = "12345";
    expect(devSoftTimeoutMs()).toBe(12_345);
  });
});
