// Shared "engine-model in a VM" runner (DESIGN §7.4.1a stage 4). Both the
// vLLM and remote-API executors have the SAME shape — the only difference is
// which AgentEngine they resolve. This module is that shared body: build the
// VM-bound acting bridge, run the framework agent loop ON THE HOST against the
// resolved engine, and capture `AgentLoopUsage` + the tool-call count.
//
// The §4.2.3 landmine ("capture AgentLoopUsage inside runFn") is handled here
// by calling the loop DIRECTLY (not through `startRun`, which only awaits a
// `Promise<void>` and drops the returned usage). We are already inside the
// run's request context (the NodeRunner / scheduler establishes it) and we are
// handed the scheduler's `AbortSignal`, so we do not need `startRun`'s thread
// bookkeeping for a single node loop.
//
// F2 executor context management (work item nv73eo2nbm — investigation
// conclusion B): the dev/spawn loop gets Observational Memory (OM) consumption
// + grown-too-long recovery + stream-resume by passing the SAME call parameters
// the in-app vLLM chat path already passes — a `threadId` (the spawn id) +
// `ownerEmail`/`orgId`. With those present, the framework `runAgentLoop`
// itself:
//   • CONSUMES OM — `applyObservationalMemoryToContext` folds a compacted
//     thread's reflections/observations into the context each iteration;
//   • PRODUCES OM — fire-and-forget `maybeCompactThread` after a clean turn;
//   • journals tool calls (anti-replay on resume).
// On top of that we:
//   • route the OUTER call through `runAgentLoopDirectWithSoftTimeout` so the
//     spawn gets stream-resume (断流续传) + anti-replay (防重放) — the SAME
//     wrapper the chat run handler uses, NOT a local reimplementation;
//   • fire an EXTRA size-triggered `maybeCompactThread` mid-turn when the
//     cumulative tool-result volume crosses the OM threshold (a long single
//     turn would otherwise only compact after it finishes), and surface a
//     visible `[observational-memory]` / `[context.compacted]` trace in
//     `spawn_events` so the Node Inspector shows OM was injected/compacted;
//   • persist a context checkpoint for a future retry (context-checkpoint.ts).
//
// The 64k context clamp is a SEPARATE ticket and is intentionally untouched.
// checkpoint 消费端在 F2b(dispatcher 重试注入)——本切片 checkpoint 只写。

import {
  actionsToEngineTools,
  runAgentLoopDirectWithSoftTimeout,
  type ActionEntry,
  type AgentChatEvent,
} from "@agent-native/core/server";
import type {
  AgentEngine,
  EngineContentPart,
  EngineMessage,
} from "@agent-native/core/agent/engine";
import {
  maybeCompactThread,
  buildObservationalContext,
  hasObservationalMemory,
} from "@agent-native/core/agent/observational-memory";

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

/**
 * Soft-timeout budget (ms) handed to `runAgentLoopDirectWithSoftTimeout` for a
 * dev spawn. A POSITIVE value activates the wrapper's resume + anti-replay
 * loop; `0` disables the wrapper entirely (it falls straight through to a bare
 * `runAgentLoop`, no resume).
 *
 * Default 600_000 (10 min) — deliberately NOT the chat handler's 40s
 * foreground wall: a spawn is background work (it runs inside the spawn
 * reconciler worker, not an HTTP request), so we pass `backgroundFunction:true`
 * at the call site which raises the hosted ceiling to the 13-min background
 * budget and keeps this 10-min default un-clamped. `ORCH_DEV_SOFT_TIMEOUT_MS`
 * overrides (set `0` to turn the wrapper off).
 */
export function devSoftTimeoutMs(): number {
  const raw = Number(process.env.ORCH_DEV_SOFT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 600_000;
}

/** Map the §1.6 effort hint onto runAgentLoop's reasoning-effort option. */
function reasoningEffort(
  effort: RuntimeExecCtx["effort"],
): "low" | "medium" | "high" | undefined {
  return effort;
}

/**
 * Reconstruct an `EngineMessage[]` transcript from the ordered step log this
 * module already builds for `spawn_events` (DESIGN §8.5), so `maybeCompactThread`
 * can run its Observer/Reflector over the REAL conversation instead of the
 * empty array it would load from the chat-threads store (a `spawn:<id>`
 * thread is never written there — the loop is called directly here, not
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

  // F2 threadId (nv73eo2nbm, conclusion B): key Observational Memory on the
  // REAL spawn id so this node execution gets OM consumption + the tool
  // journal exactly like the in-app vLLM chat. The dispatcher threads
  // `ctx.spawnId` (the `v3_spawns.id`) through NodeRunner → RuntimeExecCtx;
  // when a caller has no spawn row (schema-correction path, direct
  // NodeRunnerExecutor.invoke) we fall back to the stable-per-run
  // `ctx.node.id`. The `spawn:` prefix keeps this thread space disjoint from
  // chat threads (`bt_*`) in `observational_memory` / context-xray storage.
  const threadId = `spawn:${ctx.spawnId ?? ctx.node.id}`;

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

  const initialPromptText = buildPrompt(ctx);

  // F2 OM-injection trace (nv73eo2nbm ⑤): if this thread already has persisted
  // Observational Memory (a prior compaction of the same spawn thread), surface
  // a visible step so the Node Inspector shows OM was folded into the context.
  // The framework loop does the actual injection internally
  // (`applyObservationalMemoryToContext`) once `ownerEmail`+`threadId` are set;
  // this is the observable trace of that, gated on an authenticated owner.
  // Best-effort: any read failure is swallowed (OM is an optimization, never a
  // correctness gate — §2A "幂等与失败语义").
  if (ctx.ownerEmail) {
    try {
      const omContext = await buildObservationalContext({
        threadId,
        ownerEmail: ctx.ownerEmail,
        orgId: ctx.orgId ?? null,
        messages: [
          { role: "user", content: [{ type: "text", text: initialPromptText }] },
        ],
      });
      if (hasObservationalMemory(omContext)) {
        pushStep({
          type: "text",
          text:
            `[observational-memory] injected ${omContext.observations.length} ` +
            `observation(s) + ${omContext.reflections.length} reflection(s) for ` +
            `${threadId}; the compacted earlier history is folded into context.`,
        });
      }
    } catch (err) {
      console.warn(
        `[engine-loop] OM-injection trace skipped for ${threadId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // F2 compaction bookkeeping (T-F2-02 / T-F2-13): accumulate tool_result
  // char volume; cross the threshold exactly ONCE per spawn, then
  // fire-and-forget `maybeCompactThread`. A compaction failure is logged and
  // otherwise invisible to the loop — it is an optimization, never a
  // correctness gate. The NEXT loop iteration's `applyObservationalMemoryToContext`
  // folds the freshly-written observations into the context.
  const thresholdChars = compactThresholdChars();
  let toolResultCharsAccum = 0;
  let compactionTriggered = false;

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

  // The mutable message array the loop owns. `runAgentLoopDirectWithSoftTimeout`
  // appends its continuation nudges to THIS array in place across resume rounds,
  // so completed tool calls are never re-run and the transcript keeps growing.
  const messages: EngineMessage[] = [
    { role: "user", content: [{ type: "text", text: initialPromptText }] },
  ];

  // Call the framework loop through `runAgentLoopDirectWithSoftTimeout` (the
  // SAME wrapper the in-app chat run handler uses) so the spawn gets
  // soft-timeout + resumable-transport-error continuation (stream-resume /
  // 断流续传) and tool-call-journal anti-replay (防重放) — conclusion B, NOT a
  // local reimplementation. `threadId` + `ownerEmail`/`orgId` activate the
  // loop's internal OM consumption + post-turn compaction + tool journal.
  //
  // maxOutputTokens must be explicit (the AI SDK's ~4k default is exhausted
  // by thinking tokens on reasoning models — qwen3.6 returned an empty string
  // with it, 2026-06-21) but deliberately small: see devMaxOutputTokens().
  //
  // The soft-timeout budget is dev-shaped (see devSoftTimeoutMs): a generous
  // background budget, NOT the chat handler's 40s foreground wall.
  const usage = await runAgentLoopDirectWithSoftTimeout(
    {
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
    },
    devSoftTimeoutMs(),
    // A spawn is background work (spawn reconciler worker), not an HTTP request:
    // raise the hosted soft-timeout ceiling to the background budget so the
    // 10-min default is never clamped down to the 40s foreground wall.
    { backgroundFunction: true },
  );

  // Flush any trailing assistant text (the final answer) as its own step so a
  // node whose last action is text — not a tool call — still records it live.
  flushText();

  // F2 checkpoint (T-F2-07/T-F2-11): persist on the success path — a
  // truncated attempt's completed-writes list is exactly what a future retry
  // needs. Best-effort; never throws. (A give-up path throws out of the
  // wrapper above, so the checkpoint there is handled by the caller's retry.)
  await persistContextCheckpoint({
    nodeId: ctx.node.id,
    checkpoint: buildContextCheckpoint({ steps, finalText: finalText.trim() }),
  });

  // F7 telemetry (04 §7/§13, SDLC-051): read the input/output split from the
  // SAME terminal `usage` object the wrapper returns — accumulated across every
  // internal resume round, never per streamed chunk/event. `tokensSpent` keeps
  // its historical all-in-one meaning (cache counted as spend); the two new
  // fields below are the real components the dispatcher persists to
  // `v3_spawns.tokens_input`/`tokens_output` instead of hardcoding
  // `tokensInput: 0`.
  const tokensInput = usage.inputTokens ?? 0;
  const tokensOutput = usage.outputTokens ?? 0;
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
    tokensInput,
    tokensOutput,
    toolCallCount,
    model: usage.model || model,
    steps,
    detail: { finalText: finalText.trim() },
  };
}
