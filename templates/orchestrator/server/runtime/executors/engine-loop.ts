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
//
// F2 executor context management (SDLC docs §2 / 02-workflows.md §4.1 C1-C4):
// this is also where the dev loop gets a `threadId` (activating core's
// Observational Memory consumption + tool journal, exactly like the in-app
// vLLM chat), a size-triggered fire-and-forget compaction pass, a bounded
// local resume-on-transport-cut wrapper, and a context checkpoint persisted
// for a future retry (see context-checkpoint.ts). See the "F2 resume note"
// comment below for why the resume wrapper is a local reimplementation
// instead of importing core's `runAgentLoopDirectWithSoftTimeout`.
// checkpoint 消费端在 F2b(dispatcher 重试注入)——本切片 checkpoint 只写;
// 读取 v3_spawns.context_checkpoint 并注入重试 prompt 的 v3-dispatcher.ts
// 改动属 F2b 后续切片(F1/F4 并行期 v3-dispatcher 禁碰)。

import {
  actionsToEngineTools,
  runAgentLoop,
  type ActionEntry,
  type AgentChatEvent,
} from "@agent-native/core/server";
import type {
  AgentEngine,
  EngineContentPart,
  EngineMessage,
} from "@agent-native/core/agent/engine";
import { maybeCompactThread } from "@agent-native/core/agent/observational-memory";

import { createVmActingBridge } from "../acting-bridge.js";
import {
  buildContextCheckpoint,
  persistContextCheckpoint,
} from "./context-checkpoint.js";
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

/**
 * Per-request completion cap for dev-node loops. vLLM validates
 * `prompt + max_tokens <= max_model_len` and reserves the whole max_tokens up
 * front, so every token requested here is prompt budget lost (SDLC-060: an
 * old 200_000 value was silently clamped to core's 64k ceiling and still
 * burned 64k of window per request). 32k fits one completion turn (thinking
 * included) and leaves ~230k of the 262_144 window for the prompt.
 * ORCH_DEV_MAX_OUTPUT_TOKENS overrides (values above core's 64k clamp are
 * still clamped there).
 */
function devMaxOutputTokens(): number {
  const raw = Number(process.env.ORCH_DEV_MAX_OUTPUT_TOKENS);
  if (Number.isInteger(raw) && raw > 0) return raw;
  return 32_000;
}

/**
 * F2 compaction trigger threshold (SDLC docs §2A), expressed in tokens and
 * estimated as chars/4 (no tokenizer dependency here — same estimate the docs
 * spec uses). `ORCH_DEV_COMPACT_THRESHOLD_TOKENS` overrides; default 70_000
 * matches the design doc.
 */
export function compactThresholdTokens(): number {
  const raw = Number(process.env.ORCH_DEV_COMPACT_THRESHOLD_TOKENS);
  return Number.isFinite(raw) && raw > 0 ? raw : 70_000;
}

/** Char-count trigger point derived from {@link compactThresholdTokens}. */
export function compactThresholdChars(): number {
  return compactThresholdTokens() * 4;
}

/** Map the §1.6 effort hint onto runAgentLoop's reasoning-effort option. */
function reasoningEffort(
  effort: RuntimeExecCtx["effort"],
): "low" | "medium" | "high" | undefined {
  return effort;
}

// ─────────────────────────────────────────────────────────────────────────────
// F2 resume note (T-F2-05 / T-F2-06 — "truncated stream continues, doesn't
// restart from zero"):
//
// The design doc (SDLC §2A) calls for routing the outer `runAgentLoop` call
// through core's `runAgentLoopDirectWithSoftTimeout` (run-loop-with-resume.ts),
// which already implements soft-timeout + resumable-transport-error
// continuation. That function — and the `isResumableEngineError` /
// `appendAgentLoopContinuation` helpers it depends on — are NOT re-exported
// from any `@agent-native/core` subpath reachable from a template (verified
// against this checkout's `packages/core/package.json` "exports" map and both
// `agent/index.ts` and `server/index.ts` barrels). Adding that export is a
// `packages/core` change, which is out of bounds for this slice ("core 零改动").
//
// So this module reimplements the OBSERVABLE behavior locally, reusing only
// the already-exported `runAgentLoop`: a bounded retry loop that treats a
// narrow set of transport-cut errors as resumable, appends a "continue from
// where you left off" nudge to the SAME in-memory message array, and retries
// in the SAME spawn (not a fresh attempt) — so tool-journal-backed writes are
// never re-run and `steps`/`finalText` keep accumulating across attempts.
// A future core changeset that exports the real helpers can replace this
// block with a direct call, unchanged call-site shape.
// ─────────────────────────────────────────────────────────────────────────────

/** Bounds the local resume loop so a persistently-broken transport fails loud
 * instead of spinning forever (mirrors core's MAX_RUN_LOOP_CONTINUATIONS). */
const MAX_RESUME_ATTEMPTS = 4;

const RESUMABLE_ERROR_RE =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up|fetch failed|network|terminated|premature close|und_err|upstream connect error/i;

/**
 * Narrow, local heuristic for "this looks like a transport-level cut, not a
 * real model/tool error" — NOT a port of core's `isResumableEngineError`
 * (unreachable here; see the F2 resume note above). Never treats a
 * cooperative abort (`ctx.signal`) as resumable.
 */
export function isLikelyResumableStreamError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return false;
  return RESUMABLE_ERROR_RE.test(err.message);
}

const RESUME_CONTINUATION_TEXT =
  "The previous attempt was interrupted by a transport error before finishing. " +
  "Continue exactly where you left off. Do not repeat a tool call or file " +
  "write that already completed — check the workspace state first if unsure.";

/**
 * Reconstruct an `EngineMessage[]` transcript from the ordered step log this
 * module already builds for `spawn_events` (DESIGN §8.5), so `maybeCompactThread`
 * can run its Observer/Reflector over the REAL conversation instead of the
 * empty array it would load from the chat-threads store (a `spawn:<id>`
 * thread is never written there — `runAgentLoop` is called directly here, not
 * through the chat plugin that persists `thread_data`). Mirrors the
 * text/tool-call (assistant) + tool-result (user) alternation
 * `production-agent.ts` itself builds.
 */
export function stepsToEngineMessages(
  initialPromptText: string,
  steps: RuntimeExecStep[],
): EngineMessage[] {
  const messages: EngineMessage[] = [
    { role: "user", content: [{ type: "text", text: initialPromptText }] },
  ];
  let assistantParts: EngineContentPart[] = [];
  let toolResultParts: EngineContentPart[] = [];
  let nextCallId = 0;
  const openCallIdsByName = new Map<string, string[]>();

  const flushAssistant = (): void => {
    if (assistantParts.length === 0) return;
    messages.push({ role: "assistant", content: assistantParts });
    assistantParts = [];
  };
  const flushToolResults = (): void => {
    if (toolResultParts.length === 0) return;
    messages.push({ role: "user", content: toolResultParts });
    toolResultParts = [];
  };

  for (const step of steps) {
    if (step.type === "text") {
      if (!step.text) continue;
      flushToolResults(); // a fresh assistant turn follows any pending results
      assistantParts.push({ type: "text", text: step.text });
    } else if (step.type === "tool_use") {
      flushToolResults();
      const id = `call_${nextCallId++}`;
      const name = step.name ?? "unknown";
      const queue = openCallIdsByName.get(name) ?? [];
      queue.push(id);
      openCallIdsByName.set(name, queue);
      assistantParts.push({
        type: "tool-call",
        id,
        name,
        input: step.input,
      });
    } else if (step.type === "tool_result") {
      flushAssistant(); // the calling turn is closed before its results
      const name = step.name ?? "unknown";
      const queue = openCallIdsByName.get(name);
      const id = queue?.shift() ?? `call_${nextCallId++}`;
      toolResultParts.push({
        type: "tool-result",
        toolCallId: id,
        toolName: name,
        toolInput: "",
        content:
          typeof step.result === "string"
            ? step.result
            : JSON.stringify(step.result ?? ""),
      });
    }
  }
  flushAssistant();
  flushToolResults();
  return messages;
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

  // F2 threadId (SDLC §2A): `spawn:` prefix keeps this thread space disjoint
  // from chat threads (`bt_*`) in `observational_memory` / context-xray
  // storage (T-F2-04). `ctx.node.id` is the ONLY stable-per-run identifier
  // `RuntimeExecCtx` carries today — it is the `v3_nodes.id` the dispatcher
  // resolved this node to (unique per run+node+iteration+fanout, and stable
  // across NodeRunner's OWN internal attempt retries since those all happen
  // inside one `runner.run()` call). It is NOT the literal `v3_spawns.id`
  // (the dispatcher never threads that through `NodeRunnerInput` /
  // `RuntimeExecCtx` — doing so needs a `v3-dispatcher.ts` change, out of
  // bounds for this slice). Passing it as `threadId` still activates core's
  // OM consumption + tool journal exactly like the in-app vLLM chat does.
  const threadId = `spawn:${ctx.node.id}`;

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

  // F2 compaction bookkeeping (T-F2-02 / T-F2-13): accumulate tool_result
  // char volume; cross the threshold exactly ONCE per spawn, then
  // fire-and-forget `maybeCompactThread`. A compaction failure is logged and
  // otherwise invisible to the loop — it is an optimization, never a
  // correctness gate (§2A "幂等与失败语义").
  const thresholdChars = compactThresholdChars();
  let toolResultCharsAccum = 0;
  let compactionTriggered = false;
  const initialPromptText = buildPrompt(ctx);

  const maybeTriggerCompaction = (): void => {
    if (compactionTriggered) return;
    if (toolResultCharsAccum < thresholdChars) return;
    compactionTriggered = true;
    pushStep({
      type: "text",
      text:
        `[context.compacted] tool-result volume reached ~${toolResultCharsAccum} chars ` +
        `(threshold ~${thresholdChars}); requested an Observational Memory compaction pass.`,
    });
    const snapshot = stepsToEngineMessages(initialPromptText, steps);
    void maybeCompactThread({
      threadId,
      ownerEmail: ctx.ownerEmail,
      orgId: ctx.orgId,
      messages: snapshot,
    }).catch((err: unknown) => {
      console.warn(
        `[engine-loop] maybeCompactThread failed for ${threadId}:`,
        err instanceof Error ? err.message : String(err),
      );
    });
  };

  const send = (event: AgentChatEvent): void => {
    if (event.type === "tool_start") {
      flushText(); // close any pending reasoning text before the tool call
      toolCallCount += 1;
      pushStep({ type: "tool_use", name: event.tool, input: event.input });
    } else if (event.type === "tool_done") {
      pushStep({ type: "tool_result", name: event.tool, result: event.result });
      toolResultCharsAccum += event.result ? event.result.length : 0;
      maybeTriggerCompaction();
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
  // maxOutputTokens must be explicit (the AI SDK's ~4k default is exhausted
  // by thinking tokens on reasoning models — qwen3.6 returned an empty string
  // with it, 2026-06-21) but deliberately small: see devMaxOutputTokens().
  //
  // F2: `messages` is now a mutable array (not an inline literal) — the local
  // resume loop below appends a continuation nudge to it in place, and
  // `stepsToEngineMessages` above reconstructs the equivalent for compaction.
  const messages: EngineMessage[] = [
    { role: "user", content: [{ type: "text", text: initialPromptText }] },
  ];

  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    model,
  };
  let lastErr: unknown;
  let completed = false;

  for (let attempt = 1; attempt <= MAX_RESUME_ATTEMPTS; attempt += 1) {
    lastErr = undefined;
    try {
      const attemptUsage = await runAgentLoop({
        engine,
        model,
        systemPrompt,
        tools,
        actions,
        messages,
        send,
        signal: ctx.signal,
        ownerEmail: ctx.ownerEmail,
        orgId: ctx.orgId,
        threadId,
        reasoningEffort: reasoningEffort(ctx.effort),
        maxOutputTokens: devMaxOutputTokens(),
      });
      usage.inputTokens += attemptUsage.inputTokens ?? 0;
      usage.outputTokens += attemptUsage.outputTokens ?? 0;
      usage.cacheReadTokens += attemptUsage.cacheReadTokens ?? 0;
      usage.cacheWriteTokens += attemptUsage.cacheWriteTokens ?? 0;
      usage.model = attemptUsage.model || usage.model;
      completed = true;
      break;
    } catch (err) {
      lastErr = err;
      const canResume =
        !ctx.signal.aborted &&
        attempt < MAX_RESUME_ATTEMPTS &&
        isLikelyResumableStreamError(err);
      if (!canResume) break;
      messages.push({
        role: "user",
        content: [{ type: "text", text: RESUME_CONTINUATION_TEXT }],
      });
      pushStep({
        type: "text",
        text:
          `[loop.resumed] stream interruption recovered (attempt ${attempt} of ` +
          `${MAX_RESUME_ATTEMPTS}); continuing the same spawn without re-running ` +
          "completed work.",
      });
    }
  }

  // Flush any trailing assistant text (the final answer) as its own step so a
  // node whose last action is text — not a tool call — still records it live.
  flushText();

  // F2 checkpoint (T-F2-07/T-F2-11): persist on BOTH the success and the
  // give-up path — a failed/truncated attempt's completed-writes list is
  // exactly what a future retry needs. Best-effort; never throws.
  await persistContextCheckpoint({
    nodeId: ctx.node.id,
    checkpoint: buildContextCheckpoint({ steps, finalText: finalText.trim() }),
  });

  if (!completed) {
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  const tokensSpent =
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadTokens +
    usage.cacheWriteTokens;

  return {
    output: {
      text: finalText.trim(),
      toolCallCount,
      model: usage.model || model,
    },
    tokensSpent,
    toolCallCount,
    model: usage.model || model,
    steps,
    detail: { finalText: finalText.trim() },
  };
}
