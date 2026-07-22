import { describe, it, expect } from "vitest";

import type { Node } from "../../../shared/types.js";
import { buildClaudeCommand } from "./claude-code-executor.js";
import { parseClaudeStreamJson } from "./claude-stream.js";
import type { RuntimeExecCtx } from "./types.js";

// A representative `claude --output-format stream-json` transcript: a system
// init, an assistant turn that emits a tool_use (write) + text, a user
// tool-result, and a terminal result event carrying CUMULATIVE usage. This is
// the format the in-VM claude-code executor consumes (live E2E is P2c).
const SAMPLE = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    model: "claude-sonnet-4-6",
    session_id: "s1",
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      content: [
        { type: "text", text: "Creating the file now." },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Write",
          input: { file_path: "/work/hello.txt", content: "hi" },
        },
      ],
      usage: { input_tokens: 1200, output_tokens: 50 },
    },
  }),
  JSON.stringify({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
    },
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "Done. Wrote /work/hello.txt." }],
      usage: { input_tokens: 1300, output_tokens: 30 },
    },
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    result: "Done. Wrote /work/hello.txt.",
    is_error: false,
    num_turns: 2,
    total_cost_usd: 0.0123,
    usage: {
      input_tokens: 2500,
      output_tokens: 80,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
    },
  }),
].join("\n");

describe("parseClaudeStreamJson", () => {
  it("sums CUMULATIVE result usage, counts tool_use, captures final text + model", () => {
    const r = parseClaudeStreamJson(SAMPLE);
    // Prefer the result event's cumulative usage: 2500+80+100+20 = 2700.
    expect(r.tokensSpent).toBe(2700);
    expect(r.toolCallCount).toBe(1);
    expect(r.finalText).toBe("Done. Wrote /work/hello.txt.");
    expect(r.model).toBe("claude-sonnet-4-6");
    expect(r.sawResult).toBe(true);
    expect(r.resultSubtype).toBe("success");
    expect(r.totalCostUsd).toBeCloseTo(0.0123);
  });

  it("collects an ordered steps[] transcript: text → tool_use → tool_result → text", () => {
    const r = parseClaudeStreamJson(SAMPLE);
    // The transcript is the ordered intermediate steps (for the Node Inspector
    // execution timeline). The SAMPLE has: assistant text, a Write tool_use, a
    // user tool_result, then a final assistant text.
    expect(r.steps.map((s) => s.type)).toEqual([
      "text",
      "tool_use",
      "tool_result",
      "text",
    ]);
    // seq is monotonic 0-based.
    expect(r.steps.map((s) => s.seq)).toEqual([0, 1, 2, 3]);
    // The tool_use carries name + input + id.
    const toolUse = r.steps[1];
    expect(toolUse).toMatchObject({
      type: "tool_use",
      name: "Write",
      toolUseId: "toolu_1",
      input: { file_path: "/work/hello.txt", content: "hi" },
    });
    // The tool_result links back by tool_use_id and carries the result content.
    expect(r.steps[2]).toMatchObject({
      type: "tool_result",
      toolUseId: "toolu_1",
      result: "ok",
    });
    expect(r.steps[0]).toMatchObject({
      type: "text",
      text: "Creating the file now.",
    });
  });

  it("steps[] is empty for an empty stream (no fabrication)", () => {
    expect(parseClaudeStreamJson("").steps).toEqual([]);
  });

  it("falls back to summed per-assistant usage when no result event arrives", () => {
    const cut = SAMPLE.split("\n").slice(0, 4).join("\n"); // drop result line
    const r = parseClaudeStreamJson(cut);
    // 1200+50 + 1300+30 = 2580.
    expect(r.tokensSpent).toBe(2580);
    expect(r.toolCallCount).toBe(1);
    expect(r.sawResult).toBe(false);
  });

  it("is lenient: blank + non-JSON noise lines are skipped", () => {
    const noisy = `\n  \nwarn: some cli notice\n${SAMPLE}\nnot json at all`;
    const r = parseClaudeStreamJson(noisy);
    expect(r.tokensSpent).toBe(2700);
    expect(r.toolCallCount).toBe(1);
  });

  it("empty input yields zeros, not a throw", () => {
    const r = parseClaudeStreamJson("");
    expect(r.tokensSpent).toBe(0);
    expect(r.toolCallCount).toBe(0);
    expect(r.sawResult).toBe(false);
  });
});

describe("buildClaudeCommand", () => {
  it("builds the in-VM claude stream-json command with the node prompt + model", () => {
    const node: Node = {
      id: "n1",
      type: "agent",
      title: "demo",
      prompt: "Create /work/hello.txt with 'hi'.",
      model: "claude-sonnet-4-6",
    };
    const ctx = { node } as RuntimeExecCtx;
    const cmd = buildClaudeCommand(ctx);
    expect(cmd).toContain(
      "claude --output-format stream-json --verbose --permission-mode acceptEdits -p",
    );
    expect(cmd).toContain("'Create /work/hello.txt with '\\''hi'\\''.'");
    expect(cmd).toContain("--model 'claude-sonnet-4-6'");
  });
});

// F7 token-accounting regression tests (04 §7/§13, SDLC-051). Streaming `usage`
// is CUMULATIVE per chunk, so the input/output split must be the single FINAL
// value — never a per-chunk sum (which would quadratically inflate it) — and
// `tokens_input` must be populated (it was hardcoded to 0 before this fix).
describe("parseClaudeStreamJson — final-cumulative input/output split", () => {
  const assistant = (
    usage: Record<string, number> | undefined,
    text = "chunk",
  ): string =>
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text }],
        ...(usage ? { usage } : {}),
      },
    });

  it("records the FINAL cumulative output (10→20→30 ⇒ 30, NOT the 60 sum)", () => {
    // Provider streams cumulative output_tokens growing 10 → 20 → 30 across
    // three chunks (no terminal result event). The split must be the last value.
    const stream = [
      assistant({ input_tokens: 100, output_tokens: 10 }),
      assistant({ input_tokens: 100, output_tokens: 20 }),
      assistant({ input_tokens: 100, output_tokens: 30 }),
    ].join("\n");
    const r = parseClaudeStreamJson(stream);
    expect(r.tokensOutput).toBe(30); // final cumulative value…
    expect(r.tokensOutput).not.toBe(60); // …NOT 10+20+30 (the buggy sum)
    expect(r.tokensInput).toBe(100);
  });

  it("tokens_input is non-zero when the provider reports prompt_tokens (OpenAI alias)", () => {
    const stream = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "ok",
      usage: { prompt_tokens: 500, completion_tokens: 42 },
    });
    const r = parseClaudeStreamJson(stream);
    expect(r.tokensInput).toBe(500); // prompt_tokens → tokens_input (not 0)
    expect(r.tokensOutput).toBe(42); // completion_tokens → tokens_output
    expect(r.tokensInput).toBeGreaterThan(0);
  });

  it("usage only on the FINAL chunk still records correctly (terminal result event)", () => {
    // Earlier chunks carry NO usage; only the terminal result event does.
    const stream = [
      assistant(undefined, "a"),
      assistant(undefined, "b"),
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "done",
        usage: { input_tokens: 700, output_tokens: 90 },
      }),
    ].join("\n");
    const r = parseClaudeStreamJson(stream);
    expect(r.tokensInput).toBe(700);
    expect(r.tokensOutput).toBe(90);
  });

  it("usage only on the final assistant message (no result event) still records", () => {
    const stream = [
      assistant(undefined, "a"),
      assistant({ input_tokens: 250, output_tokens: 33 }, "b"),
    ].join("\n");
    const r = parseClaudeStreamJson(stream);
    expect(r.sawResult).toBe(false);
    expect(r.tokensInput).toBe(250);
    expect(r.tokensOutput).toBe(33);
  });

  it("prefers the terminal result usage over per-message usage (final wins)", () => {
    const stream = [
      assistant({ input_tokens: 100, output_tokens: 10 }),
      assistant({ input_tokens: 200, output_tokens: 20 }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "done",
        usage: {
          input_tokens: 200,
          output_tokens: 20,
          cache_read_input_tokens: 50,
        },
      }),
    ].join("\n");
    const r = parseClaudeStreamJson(stream);
    expect(r.tokensInput).toBe(200);
    expect(r.tokensOutput).toBe(20);
  });

  it("exposes the split on the canonical SAMPLE (input 2500 / output 80)", () => {
    const r = parseClaudeStreamJson(SAMPLE);
    expect(r.tokensInput).toBe(2500);
    expect(r.tokensOutput).toBe(80);
  });
});
