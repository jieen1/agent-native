import { describe, expect, it } from "vitest";

import type { AgentEngine, EngineEvent } from "./engine/types.js";
import { runAgentLoop } from "./production-agent.js";

/**
 * Spawn token-telemetry regression tests.
 *
 * Streaming `usage` is CUMULATIVE: each chunk that carries a usage object
 * reports the running total so far (Anthropic `message_delta`, the AI SDK's
 * `finish.totalUsage`, and OpenAI-compatible `stream_options.include_usage`
 * all behave this way). The agent loop used to ADD every per-chunk usage to a
 * running accumulator, which quadratically inflated `outputTokens` (a 4-minute
 * spawn recorded ~1.3M output tokens / ~5200 tok·s on a local 27B model) and
 * never captured `inputTokens` (prompt tokens) at all. The loop must instead
 * take ONLY the final usage reported at stream end.
 */

const CAPABILITIES = {
  thinking: false,
  promptCaching: false,
  vision: false,
  computerUse: false,
  parallelToolCalls: false,
} as const;

type UsageEvent = Extract<EngineEvent, { type: "usage" }>;

/**
 * Build a single-turn engine whose stream emits the supplied cumulative usage
 * events (in order) followed by a terminal text answer and `end_turn` stop.
 */
function engineWithCumulativeUsage(usageEvents: UsageEvent[]): AgentEngine {
  return {
    name: "test",
    label: "Test",
    defaultModel: "test-model",
    supportedModels: ["test-model"],
    capabilities: CAPABILITIES,
    async *stream(): AsyncIterable<EngineEvent> {
      for (const usage of usageEvents) {
        yield usage;
      }
      yield {
        type: "assistant-content",
        parts: [{ type: "text" as const, text: "done" }],
      };
      yield { type: "stop", reason: "end_turn" };
    },
  };
}

async function runOnce(engine: AgentEngine) {
  return runAgentLoop({
    engine,
    model: "test-model",
    systemPrompt: "system",
    tools: [],
    availableTools: [],
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    actions: {},
    send: () => {},
    signal: new AbortController().signal,
  });
}

describe("runAgentLoop cumulative usage handling", () => {
  it("records the FINAL cumulative output total, not the sum across chunks", async () => {
    // Provider reports cumulative usage on every chunk: 10 -> 20 -> 30.
    const usage = await runOnce(
      engineWithCumulativeUsage([
        { type: "usage", inputTokens: 5, outputTokens: 10 },
        { type: "usage", inputTokens: 5, outputTokens: 20 },
        { type: "usage", inputTokens: 5, outputTokens: 30 },
      ]),
    );

    // Must equal the last (final) total — 30 — not 10+20+30 = 60.
    expect(usage.outputTokens).toBe(30);
  });

  it("records tokens_input from the final usage's prompt/input tokens", async () => {
    const usage = await runOnce(
      engineWithCumulativeUsage([
        { type: "usage", inputTokens: 120, outputTokens: 10 },
        { type: "usage", inputTokens: 120, outputTokens: 30 },
      ]),
    );

    // inputTokens (prompt tokens) must be captured, not hardcoded to 0.
    expect(usage.inputTokens).toBe(120);
    expect(usage.outputTokens).toBe(30);
  });

  it("records correctly when usage arrives only on the final chunk", async () => {
    const usage = await runOnce(
      engineWithCumulativeUsage([
        { type: "usage", inputTokens: 42, outputTokens: 17 },
      ]),
    );

    expect(usage.inputTokens).toBe(42);
    expect(usage.outputTokens).toBe(17);
  });

  it("captures cache token components from the final usage", async () => {
    const usage = await runOnce(
      engineWithCumulativeUsage([
        {
          type: "usage",
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 5,
          cacheWriteTokens: 2,
        },
        {
          type: "usage",
          inputTokens: 100,
          outputTokens: 25,
          cacheReadTokens: 5,
          cacheWriteTokens: 2,
        },
      ]),
    );

    expect(usage.outputTokens).toBe(25);
    expect(usage.cacheReadTokens).toBe(5);
    expect(usage.cacheWriteTokens).toBe(2);
  });
});
