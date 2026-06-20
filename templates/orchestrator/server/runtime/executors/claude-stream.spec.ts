import { describe, it, expect } from "vitest";

import { parseClaudeStreamJson } from "./claude-stream.js";
import { buildClaudeCommand } from "./claude-code-executor.js";
import type { RuntimeExecCtx } from "./types.js";
import type { Node } from "../../../shared/types.js";

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
    expect(cmd).toContain("claude --output-format stream-json --verbose -p");
    expect(cmd).toContain("'Create /work/hello.txt with '\\''hi'\\''.'");
    expect(cmd).toContain("--model 'claude-sonnet-4-6'");
  });
});
