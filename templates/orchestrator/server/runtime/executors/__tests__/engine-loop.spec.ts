// F2 executor context management (SDLC docs §2/§6.2) — engine-loop.ts wiring
// tests. Drives `runEngineLoopInVm` against a MOCK `runAgentLoop` (an AI-SDK
// stand-in) that emits the same `send` events the real core loop would, so
// these specs exercise engine-loop.ts's OWN logic (threadId wiring, the
// compaction trigger, the local resume loop, checkpoint persistence) without
// needing a live model, VM, or Postgres. Per the F2 test plan, the OM/resume
// integration surface is driven through a mock engine + a small compaction
// threshold env override, not a live 101 window.

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { RuntimeExecCtx, RuntimeExecStep } from "../types.js";

// ── Hoisted mocks (vi.mock factories run before imports) ───────────────────
const hoisted = vi.hoisted(() => ({
  runAgentLoop: vi.fn(),
  actionsToEngineTools: vi.fn((actions: Record<string, unknown>) =>
    Object.keys(actions).map((name) => ({
      name,
      description: "",
      inputSchema: { type: "object" as const },
    })),
  ),
  maybeCompactThread: vi.fn(),
  persistContextCheckpoint: vi.fn(),
}));

vi.mock("@agent-native/core/server", () => ({
  runAgentLoop: hoisted.runAgentLoop,
  actionsToEngineTools: hoisted.actionsToEngineTools,
}));

vi.mock("@agent-native/core/agent/observational-memory", () => ({
  maybeCompactThread: hoisted.maybeCompactThread,
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
  isLikelyResumableStreamError,
  stepsToEngineMessages,
  compactThresholdTokens,
  compactThresholdChars,
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
  hoisted.persistContextCheckpoint.mockResolvedValue(undefined);
  hoisted.maybeCompactThread.mockResolvedValue({ observer: {}, reflector: {} });
});

// ── threadId / OM activation wiring (T-F2-03 / T-F2-04) ─────────────────────

describe("threadId + ownerEmail/orgId wiring (T-F2-03/T-F2-04)", () => {
  it("passes a spawn:-prefixed threadId derived from ctx.node.id, plus ownerEmail/orgId", async () => {
    hoisted.runAgentLoop.mockResolvedValueOnce(baseUsage());
    const ctx = makeCtx({
      node: { id: "node-xyz", type: "agent", title: "t" } as never,
    });

    await runEngineLoopInVm({
      ctx,
      engine: {} as never,
      model: "m1",
      kind: "vllm",
    });

    expect(hoisted.runAgentLoop).toHaveBeenCalledTimes(1);
    const callArgs = hoisted.runAgentLoop.mock.calls[0][0];
    expect(callArgs.threadId).toBe("spawn:node-xyz");
    expect(callArgs.ownerEmail).toBe("owner@example.com");
    expect(callArgs.orgId).toBe("org-1");
  });

  it("uses a distinct threadId per node id (no cross-node collision)", async () => {
    hoisted.runAgentLoop.mockResolvedValue(baseUsage());
    await runEngineLoopInVm({
      ctx: makeCtx({ node: { id: "node-a", type: "agent", title: "t" } as never }),
      engine: {} as never,
      model: "m1",
      kind: "vllm",
    });
    await runEngineLoopInVm({
      ctx: makeCtx({ node: { id: "node-b", type: "agent", title: "t" } as never }),
      engine: {} as never,
      model: "m1",
      kind: "vllm",
    });
    const threadIds = hoisted.runAgentLoop.mock.calls.map((c) => c[0].threadId);
    expect(threadIds).toEqual(["spawn:node-a", "spawn:node-b"]);
  });
});

// ── devMaxOutputTokens (T-F2-08) ─────────────────────────────────────────────

describe("devMaxOutputTokens (T-F2-08 — 32k regression)", () => {
  it("defaults maxOutputTokens to 32000", async () => {
    hoisted.runAgentLoop.mockResolvedValueOnce(baseUsage());
    await runEngineLoopInVm({
      ctx: makeCtx(),
      engine: {} as never,
      model: "m1",
      kind: "vllm",
    });
    expect(hoisted.runAgentLoop.mock.calls[0][0].maxOutputTokens).toBe(32_000);
  });

  it("respects an ORCH_DEV_MAX_OUTPUT_TOKENS override", async () => {
    process.env.ORCH_DEV_MAX_OUTPUT_TOKENS = "16000";
    hoisted.runAgentLoop.mockResolvedValueOnce(baseUsage());
    await runEngineLoopInVm({
      ctx: makeCtx(),
      engine: {} as never,
      model: "m1",
      kind: "vllm",
    });
    expect(hoisted.runAgentLoop.mock.calls[0][0].maxOutputTokens).toBe(16_000);
  });

  it("never reverts to the old 200000 hardcode regardless of override", async () => {
    process.env.ORCH_DEV_MAX_OUTPUT_TOKENS = "not-a-number";
    hoisted.runAgentLoop.mockResolvedValueOnce(baseUsage());
    await runEngineLoopInVm({
      ctx: makeCtx(),
      engine: {} as never,
      model: "m1",
      kind: "vllm",
    });
    expect(hoisted.runAgentLoop.mock.calls[0][0].maxOutputTokens).toBe(32_000);
  });
});

// ── Compaction threshold trigger (T-F2-02) ──────────────────────────────────

describe("compaction threshold trigger (T-F2-02)", () => {
  it("triggers maybeCompactThread exactly once after crossing the char threshold", async () => {
    process.env.ORCH_DEV_COMPACT_THRESHOLD_TOKENS = "10"; // threshold = 40 chars
    hoisted.runAgentLoop.mockImplementationOnce(async (opts: { send: SendFn }) => {
      opts.send({ type: "tool_start", tool: "bash", input: {} });
      opts.send({ type: "tool_done", tool: "bash", result: "x".repeat(20) }); // 20 < 40
      opts.send({ type: "tool_start", tool: "bash", input: {} });
      opts.send({ type: "tool_done", tool: "bash", result: "y".repeat(30) }); // 50 > 40 -> fires once
      opts.send({ type: "tool_start", tool: "bash", input: {} });
      opts.send({ type: "tool_done", tool: "bash", result: "z".repeat(30) }); // stays fired-once
      return baseUsage();
    });

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
    hoisted.runAgentLoop.mockImplementationOnce(async (opts: { send: SendFn }) => {
      opts.send({ type: "tool_start", tool: "bash", input: {} });
      opts.send({ type: "tool_done", tool: "bash", result: "short" });
      return baseUsage();
    });

    await runEngineLoopInVm({
      ctx: makeCtx(),
      engine: {} as never,
      model: "m1",
      kind: "vllm",
    });

    expect(hoisted.maybeCompactThread).not.toHaveBeenCalled();
  });

  it("passes a reconstructed message transcript (not empty) to maybeCompactThread", async () => {
    process.env.ORCH_DEV_COMPACT_THRESHOLD_TOKENS = "1";
    hoisted.runAgentLoop.mockImplementationOnce(async (opts: { send: SendFn }) => {
      opts.send({ type: "tool_start", tool: "bash", input: { command: "ls" } });
      opts.send({ type: "tool_done", tool: "bash", result: "a.ts\nb.ts" });
      return baseUsage();
    });

    await runEngineLoopInVm({
      ctx: makeCtx(),
      engine: {} as never,
      model: "m1",
      kind: "vllm",
    });

    expect(hoisted.maybeCompactThread).toHaveBeenCalledTimes(1);
    const call = hoisted.maybeCompactThread.mock.calls[0][0];
    expect(call.threadId).toBe("spawn:node-abc");
    expect(call.ownerEmail).toBe("owner@example.com");
    expect(Array.isArray(call.messages)).toBe(true);
    expect(call.messages.length).toBeGreaterThan(0);
  });
});

// ── Compaction failure is fire-and-forget (T-F2-13) ─────────────────────────

describe("compaction failure never breaks the run (T-F2-13)", () => {
  it("swallows a maybeCompactThread rejection, completes normally, and never triggers a resume", async () => {
    process.env.ORCH_DEV_COMPACT_THRESHOLD_TOKENS = "1";
    hoisted.maybeCompactThread.mockRejectedValueOnce(new Error("compaction boom"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    hoisted.runAgentLoop.mockImplementationOnce(async (opts: { send: SendFn }) => {
      opts.send({ type: "tool_start", tool: "bash", input: {} });
      opts.send({ type: "tool_done", tool: "bash", result: "x".repeat(50) });
      return baseUsage();
    });

    const result = await runEngineLoopInVm({
      ctx: makeCtx(),
      engine: {} as never,
      model: "m1",
      kind: "vllm",
    });

    // Let the fire-and-forget rejection's .catch() settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.toolCallCount).toBe(1);
    expect(hoisted.runAgentLoop).toHaveBeenCalledTimes(1); // no resume triggered
    const resumedSteps = (result.steps ?? []).filter(
      (s) => s.type === "text" && s.text?.includes("[loop.resumed]"),
    );
    expect(resumedSteps).toHaveLength(0);

    warnSpy.mockRestore();
  });
});

// ── Local resume-on-transport-cut wrapper (T-F2-05/T-F2-06 intent) ──────────

describe("resume after a transport-cut error", () => {
  it("retries the same spawn, preserving prior steps and appending a continuation nudge", async () => {
    hoisted.runAgentLoop
      .mockImplementationOnce(async (opts: { send: SendFn }) => {
        opts.send({ type: "tool_start", tool: "write", input: { filePath: "a.ts" } });
        opts.send({ type: "tool_done", tool: "write", result: "Wrote a.ts (1 line)." });
        throw new Error("socket hang up");
      })
      .mockImplementationOnce(
        async (opts: { send: SendFn; messages: Array<{ role: string }> }) => {
          const last = opts.messages[opts.messages.length - 1];
          expect(last.role).toBe("user");
          opts.send({ type: "text", text: "Continuing and finishing up." });
          return baseUsage({ inputTokens: 2, outputTokens: 2 });
        },
      );

    const result = await runEngineLoopInVm({
      ctx: makeCtx(),
      engine: {} as never,
      model: "m1",
      kind: "vllm",
    });

    expect(hoisted.runAgentLoop).toHaveBeenCalledTimes(2);
    // The write from attempt 1 is preserved in the transcript, not re-run.
    expect(result.toolCallCount).toBe(1);
    const resumedMarker = (result.steps ?? []).some(
      (s) => s.type === "text" && s.text?.includes("[loop.resumed]"),
    );
    expect(resumedMarker).toBe(true);
    expect((result.output as { text: string }).text).toContain(
      "Continuing and finishing up.",
    );
  });

  it("does not retry a non-resumable error, but still persists a checkpoint before rethrowing (T-F2-07)", async () => {
    hoisted.runAgentLoop.mockImplementationOnce(async (opts: { send: SendFn }) => {
      opts.send({ type: "tool_start", tool: "write", input: { filePath: "a.ts" } });
      opts.send({ type: "tool_done", tool: "write", result: "Wrote a.ts (1 line)." });
      throw new Error("schema validation failed: bad input");
    });

    await expect(
      runEngineLoopInVm({
        ctx: makeCtx(),
        engine: {} as never,
        model: "m1",
        kind: "vllm",
      }),
    ).rejects.toThrow("schema validation failed");

    expect(hoisted.runAgentLoop).toHaveBeenCalledTimes(1);
    expect(hoisted.persistContextCheckpoint).toHaveBeenCalledTimes(1);
    const persisted = hoisted.persistContextCheckpoint.mock.calls[0][0];
    expect(persisted.nodeId).toBe("node-abc");
    expect(persisted.checkpoint.writtenFiles).toEqual(["a.ts"]);
  });

  it("gives up and rethrows after exhausting the resume attempt bound", async () => {
    hoisted.runAgentLoop.mockImplementation(async () => {
      throw new Error("ECONNRESET");
    });

    await expect(
      runEngineLoopInVm({
        ctx: makeCtx(),
        engine: {} as never,
        model: "m1",
        kind: "vllm",
      }),
    ).rejects.toThrow("ECONNRESET");

    // Bounded — must not retry forever.
    expect(hoisted.runAgentLoop.mock.calls.length).toBeGreaterThan(1);
    expect(hoisted.runAgentLoop.mock.calls.length).toBeLessThanOrEqual(4);
  });
});

// ── Checkpoint persists on success too (T-F2-07) ────────────────────────────

describe("checkpoint persistence on success (T-F2-07)", () => {
  it("persists a checkpoint after a normal successful completion", async () => {
    hoisted.runAgentLoop.mockImplementationOnce(async (opts: { send: SendFn }) => {
      opts.send({ type: "tool_start", tool: "write", input: { filePath: "a.ts" } });
      opts.send({ type: "tool_done", tool: "write", result: "Wrote a.ts (1 line)." });
      opts.send({ type: "text", text: "Done." });
      return baseUsage();
    });

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

describe("isLikelyResumableStreamError", () => {
  it("treats common transport-cut errors as resumable", () => {
    expect(isLikelyResumableStreamError(new Error("socket hang up"))).toBe(true);
    expect(
      isLikelyResumableStreamError(
        new Error("connect ECONNREFUSED 127.0.0.1:9000"),
      ),
    ).toBe(true);
    expect(isLikelyResumableStreamError(new Error("fetch failed"))).toBe(true);
  });

  it("does not treat a cooperative abort or a generic error as resumable", () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    expect(isLikelyResumableStreamError(abortErr)).toBe(false);
    expect(isLikelyResumableStreamError(new Error("invalid schema"))).toBe(false);
    expect(isLikelyResumableStreamError("not an error")).toBe(false);
  });
});

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
