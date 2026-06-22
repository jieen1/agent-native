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
import type { RuntimeExecCtx, RuntimeExecResult } from "./types.js";
import { DEFAULT_WORKDIR } from "./workdir.js";

// Re-exported from its own light module (executors/workdir.ts) so light
// consumers don't pull in this heavy engine-loop just for the constant.
export { DEFAULT_WORKDIR };

/** Build the user-turn instruction from the node prompt + resolved deps/item. */
export function buildPrompt(ctx: RuntimeExecCtx): string {
  const lines: string[] = [];
  lines.push(ctx.node.prompt ?? ctx.node.title ?? "Complete the task.");
  if (ctx.item !== undefined) {
    lines.push("");
    lines.push(`Input item:\n${safeJson(ctx.item)}`);
  }
  const depKeys = Object.keys(ctx.deps);
  if (depKeys.length > 0) {
    lines.push("");
    lines.push(`Dependency outputs:\n${safeJson(ctx.deps)}`);
  }
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
  let toolCallCount = 0;
  let finalText = "";
  const send = (event: AgentChatEvent): void => {
    if (event.type === "tool_start") toolCallCount += 1;
    else if (event.type === "text") finalText += event.text;
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

  const tokensSpent =
    (usage.inputTokens ?? 0) +
    (usage.outputTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0);

  return {
    output: {
      text: finalText.trim(),
      toolCallCount,
      model: usage.model || model,
    },
    tokensSpent,
    toolCallCount,
    model: usage.model || model,
    detail: { finalText: finalText.trim() },
  };
}
