import { describe, it, expect } from "vitest";

import { parseClaudeStreamJson } from "./claude-stream.js";

/**
 * SDLC-051 regression test: streaming usage is CUMULATIVE per chunk, not a
 * delta. The parser must record ONLY the final cumulative value — never sum
 * per-chunk usage (which would quadratically inflate tokens_output) — and must
 * extract tokens_input from prompt_tokens/input_tokens (never leave it 0).
 */
describe("parseClaudeStreamJson token accounting (SDLC-051)", () => {
  it("records final cumulative usage (10→20→30 → tokens_output=30, not 60)", () => {
    // Simulate a provider that sends incremental usage chunks: 10, then 20,
    // then 30 (cumulative). The parser must take the FINAL value (30), not sum
    // them (10+20+30=60).
    const stream = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "partial" }],
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "more" }],
          usage: { input_tokens: 100, output_tokens: 20 },
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "final" }],
          usage: { input_tokens: 100, output_tokens: 30 },
        },
      }),
    ].join("\n");

    const r = parseClaudeStreamJson(stream);
    // Final cumulative output_tokens = 30 (NOT 10+20+30=60).
    expect(r.tokensOutput).toBe(30);
    // Input tokens are also from the final read (100, not summed).
    expect(r.tokensInput).toBe(100);
    // Total = input + output = 130.
    expect(r.tokensSpent).toBe(130);
  });

  it("sets tokens_input from prompt_tokens (non-zero when provider reports it)", () => {
    const stream = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "hello" }],
          usage: { prompt_tokens: 500, completion_tokens: 50 },
        },
      }),
    ].join("\n");

    const r = parseClaudeStreamJson(stream);
    // tokens_input is set from prompt_tokens (not 0).
    expect(r.tokensInput).toBe(500);
    expect(r.tokensOutput).toBe(50);
    expect(r.tokensSpent).toBe(550);
  });

  it("records correctly when usage is only on the final result chunk", () => {
    // Some providers send usage ONLY on the terminal result event (not on
    // intermediate assistant chunks). The parser must still extract it.
    const stream = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "working..." }],
          // No usage here.
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "done",
        usage: { input_tokens: 1000, output_tokens: 200 },
      }),
    ].join("\n");

    const r = parseClaudeStreamJson(stream);
    expect(r.tokensInput).toBe(1000);
    expect(r.tokensOutput).toBe(200);
    expect(r.tokensSpent).toBe(1200);
    expect(r.sawResult).toBe(true);
  });

  it("includes cache tokens in tokens_input (matches tokensSpent composition)", () => {
    const stream = [
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "done",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 20,
        },
      }),
    ].join("\n");

    const r = parseClaudeStreamJson(stream);
    // tokens_input includes cache read + cache creation (100+30+20=150).
    expect(r.tokensInput).toBe(150);
    expect(r.tokensOutput).toBe(50);
    // tokensSpent = input (incl. cache) + output = 150+50=200.
    expect(r.tokensSpent).toBe(200);
  });

  it("prefers terminal result usage over intermediate assistant usage", () => {
    // When both assistant chunks and a terminal result carry usage, the result
    // event's cumulative usage is authoritative.
    const stream = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "partial" }],
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "done",
        usage: { input_tokens: 500, output_tokens: 100 },
      }),
    ].join("\n");

    const r = parseClaudeStreamJson(stream);
    // Use the result event's usage (500/100), not the assistant's (100/10).
    expect(r.tokensInput).toBe(500);
    expect(r.tokensOutput).toBe(100);
    expect(r.tokensSpent).toBe(600);
  });
});
