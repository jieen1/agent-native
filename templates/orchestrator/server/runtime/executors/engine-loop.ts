// Shared "engine-model in a VM" runner (DESIGN §7.4.1a stage 4). Both the
// vLLM and remote-API executors have the SAME shape — the only difference is
// which AgentEngine they resolve. This module is that shared body: build the
// VM-bound acting bridge, run `runAgentLoop` ON THE HOST against the resolved
// engine, and capture `AgentLoopUsage` + the tool-call count from the run.
//
// The §4.2.3 landmine ("capture AgentLoopUsage inside runFn") is handled here
// by calling `runAgentLoop` DIRECTLY (not through `startRun`, which only awaits
// a `Promise<void>` and drops the returned usage). We are already inside the
// run's request context (the NodeRunner / scheduler establishes it) and we are
// handed the scheduler's `AbortSignal`, so we do not need `startRun`'s thread
// bookkeeping for a single node loop.

import {
  actionsToEngineTools,
  runAgentLoop,
  type ActionEntry,
  type AgentChatEvent,
} from "@agent-native/core/server";
import type { AgentEngine } from "@agent-native/core/agent/engine";

import { createVmActingBridge } from "../acting-bridge.js";
import type {
  RuntimeExecCtx,
  RuntimeExecResult,
  RuntimeExecStep,
} from "./types.js";
import { DEFAULT_WORKDIR } from "./workdir.js";

// Re-exported from its own light module (executors/workdir.ts) so light
// consumers don't pull in this heavy engine-loop just for the constant.
export { DEFAULT_WORKDIR };

/** Build the user-turn instruction from the node prompt + resolved deps/item.
 *
 * DESIGN §6.5 / I7: the backend does NOT auto-dump deps into the prompt.
 * The only data that crosses into the spawn is the rendered prompt string
 * (already interpolated by the dispatcher via renderTemplate). We only
 * append the `item` value for fanout children (that IS part of the channel
 * contract — it is the per-item slot the author writes `{{item}}` for).
 */
export function buildPrompt(ctx: RuntimeExecCtx): string {
  const lines: string[] = [];
  lines.push(ctx.node.prompt ?? ctx.node.title ?? "Complete the task.");
  if (ctx.item !== undefined) {
    lines.push("");
    lines.push(`Input item:\n${safeJson(ctx.item)}`);
  }
  // NOTE: deps are intentionally NOT appended here (I7 / DESIGN §6.5).
  // Authors inject upstream outputs via {{deps.X.output.Y}} in the node
  // prompt; the dispatcher resolves those references before calling the
  // executor. Appending a raw JSON dump of deps would violate the channel
  // contract and is explicitly listed as a non-goal.
  lines.push("");
  lines.push(
    `You are acting inside an isolated workspace at ${
      ctx.workdir
    }. Use the bash/read/edit/write tools to do real work there. ` +
      "When done, briefly state what you changed.",
  );
  return lines.join("\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Map the §1.6 effort hint onto runAgentLoop's reasoning-effort option. */
function reasoningEffort(
  effort: RuntimeExecCtx["effort"],
): "low" | "medium" | "high" | undefined {
  return effort;
}

/**
 * Run an engine-model agent loop for one node, acting through VM-bound tools.
 * `engine`/`model` are resolved by the caller (vLLM vs remote-API); everything
 * else is identical.
 */
export async function runEngineLoopInVm(args: {
  ctx: RuntimeExecCtx;
  engine: AgentEngine;
  model: string;
  kind: string;
}): Promise<RuntimeExecResult> {
  const { ctx, engine, model } = args;
  const workdir = ctx.workdir || DEFAULT_WORKDIR;

  // The VM-bound acting bridge — same tool CONTRACT createCodingToolRegistry
  // exposes, side effects reimplemented against the VM (DESIGN §7.4.1a).
  const actions: Record<string, ActionEntry> = createVmActingBridge({
    runtime: ctx.runtime,
    vm: ctx.vm,
    workdir,
  });
  const tools = actionsToEngineTools(actions);

  // Tally tool calls + capture the final assistant text from the event stream.
  // ALSO collect the ordered intermediate transcript (reasoning text, tool_start
  // → name+input, tool_done → result) so the dispatcher can persist it as
  // `spawn_events` for the Node Inspector — the AI-SDK loop surfaces every step
  // through this `send` sink (DESIGN §8.5).
  //
  // LIVE capture (DESIGN §8.5): each step is pushed out through `ctx.onStep` AS
  // IT IS FINALIZED, so a RUNNING node grows its `spawn_events` stream in real
  // time. Assistant-text deltas are buffered and flushed as one text step at the
  // next boundary (tool call / end) so we don't emit a row per token but still
  // stream promptly. seq is monotonic and shared with the returned `steps[]`, so
  // the live append (`onConflictDoNothing` on (spawn_id, seq)) and the final
  // return never disagree.
  let toolCallCount = 0;
  let finalText = "";
  const steps: RuntimeExecStep[] = [];
  const emit = (s: RuntimeExecStep): void => {
    try {
      args.ctx.onStep?.(s);
    } catch {
      // A sink error must never abort the model loop.
    }
  };
  const pushStep = (s: Omit<RuntimeExecStep, "seq">): void => {
    const step = { seq: steps.length, ...s } as RuntimeExecStep;
    steps.push(step);
    emit(step);
  };
  let textBuf = "";
  const flushText = (): void => {
    const t = textBuf.trim();
    textBuf = "";
    if (t) pushStep({ type: "text", text: t });
  };
  const send = (event: AgentChatEvent): void => {
    if (event.type === "tool_start") {
      flushText(); // close any pending reasoning text before the tool call
      toolCallCount += 1;
      pushStep({ type: "tool_use", name: event.tool, input: event.input });
    } else if (event.type === "tool_done") {
      pushStep({ type: "tool_result", name: event.tool, result: event.result });
    } else if (event.type === "text") {
      finalText += event.text;
      textBuf += event.text; // buffered; flushed at the next boundary
    } else if (event.type === "thinking" && event.text) {
      // Reasoning surfaces as its own text step (flush any prior buffer first).
      flushText();
      pushStep({ type: "text", text: event.text });
    }
  };

  const systemPrompt =
    "You are a coding agent operating inside an isolated microVM workspace. " +
    "You have bash, read, edit, and write tools that act on files inside the " +
    "workspace. Always use the tools to make real changes; never claim a " +
    "change you did not perform with a tool.";

  // Call runAgentLoop DIRECTLY so its returned AgentLoopUsage is captured
  // (DESIGN §4.2.3). We are already in the run's request context.
  //
  // maxOutputTokens is set to the model's full context window because the AI
  // SDK applies a small DEFAULT (~4k) when the option is omitted — that cap is
  // EXHAUSTED by thinking tokens on reasoning models (qwen3.6 thinking returned
  // an empty string + toolCallCount=0 with the default, 2026-06-21). Local vLLM
  // has no usage quota, and a server-side `max_model_len` (262_144 on qwen3.6)
  // already bounds the actual response — passing a generous client cap simply
  // means "do not let the SDK clip you; the server is the real limit".
  const usage = await runAgentLoop({
    engine,
    model,
    systemPrompt,
    tools,
    actions,
    messages: [
      { role: "user", content: [{ type: "text", text: buildPrompt(ctx) }] },
    ],
    send,
    signal: ctx.signal,
    ownerEmail: ctx.ownerEmail,
    orgId: ctx.orgId,
    reasoningEffort: reasoningEffort(ctx.effort),
    maxOutputTokens: 200_000,
  });

  // F7 telemetry (04 §7/§13, SDLC-051): read the input/output split from THIS
  // SAME terminal `usage` object — the one `runAgentLoop` returns at the end of
  // the whole loop, never accumulated per streamed chunk/event. `tokensSpent`
  // keeps its historical all-in-one meaning (cache counted as spend); the two
  // new fields below are the real components the dispatcher persists to
  // `v3_spawns.tokens_input`/`tokens_output` instead of hardcoding
  // `tokensInput: 0`.
  const tokensInput = usage.inputTokens ?? 0;
  const tokensOutput = usage.outputTokens ?? 0;
  const tokensSpent =
    tokensInput +
    tokensOutput +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0);

  // Flush any trailing assistant text (the final answer) as its own step so a
  // node whose last action is text — not a tool call — still records it live.
  flushText();

  return {
    output: {
      text: finalText.trim(),
      toolCallCount,
      model: usage.model || model,
    },
    tokensSpent,
    tokensInput,
    tokensOutput,
    toolCallCount,
    model: usage.model || model,
    steps,
    detail: { finalText: finalText.trim() },
  };
}
