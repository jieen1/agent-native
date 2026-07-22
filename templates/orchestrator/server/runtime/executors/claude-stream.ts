// Parser for the Claude Code CLI `--output-format stream-json` event stream
// (DESIGN §7.4.1a — the claude-code executor consumes this). Pure + sync so it
// is unit-testable from a captured sample without a VM (the live in-VM E2E is
// P2c: it needs VM public egress + a `~/.claude` mount).
//
// The CLI emits NEWLINE-DELIMITED JSON. Each line is one event object:
//   { "type": "system", "subtype": "init", ... }            — session start
//   { "type": "assistant", "message": { content[], usage } } — a model turn;
//        content blocks may include { "type": "tool_use", name, input }
//   { "type": "user", "message": { content[] } }            — tool results
//   { "type": "result", "subtype": "success"|"error_*",
//        "result": "<final text>", "usage": {...},
//        "total_cost_usd": N, "num_turns": N }               — terminal summary
//
// `usage` objects carry `input_tokens`, `output_tokens`,
// `cache_read_input_tokens`, `cache_creation_input_tokens`. The terminal
// `result` event's `usage` is CUMULATIVE, so we prefer it; if no `result`
// event arrived (stream cut off), we fall back to summing per-assistant usage.

/**
 * One ordered intermediate step extracted from the stream (DESIGN §8.5 — the
 * Node Inspector "执行过程 / Execution" timeline). A spawn's full transcript is a
 * `seq`-ordered list of these, mirroring the brain's `brain_events` shape so the
 * run-detail timeline can render the same reasoning + tool-call cards.
 */
export interface ClaudeStreamStep {
  /** Monotonic order within this spawn (0-based). */
  seq: number;
  /** The step kind. */
  type: "text" | "tool_use" | "tool_result";
  /** Tool name for a `tool_use` step. */
  name?: string;
  /** The model-side tool-call id (links a tool_use to its tool_result). */
  toolUseId?: string;
  /** The tool input object for a `tool_use` step. */
  input?: unknown;
  /** The tool result content for a `tool_result` step. */
  result?: unknown;
  /** Assistant reasoning/answer text for a `text` step. */
  text?: string;
}

/** Aggregated outcome of parsing a claude stream-json transcript. */
export interface ClaudeStreamParseResult {
  /** Total tokens (input + output + cache read + cache write). */
  tokensSpent: number;
  /**
   * F7 telemetry split (04 §7/§13, SDLC-051): the INPUT component of the spawn's
   * token usage, persisted to `v3_spawns.tokens_input`. Taken from the FINAL
   * cumulative usage (the terminal `result` event when present, else the last
   * non-null per-message usage) — NEVER a sum across chunks. Streaming `usage`
   * is CUMULATIVE per chunk, so summing would quadratically inflate it; the
   * correct input count is the single final value. Reads `input_tokens` or the
   * OpenAI-style `prompt_tokens` alias. 0 only when no usage was ever reported.
   */
  tokensInput: number;
  /**
   * F7 telemetry split: the OUTPUT component, persisted to
   * `v3_spawns.tokens_output`. Same FINAL-cumulative semantics as
   * {@link tokensInput} — the single final `output_tokens`/`completion_tokens`
   * value, never a per-chunk sum.
   */
  tokensOutput: number;
  /** Number of `tool_use` blocks the model emitted (proof of real acting). */
  toolCallCount: number;
  /** The final assistant/result text. */
  finalText: string;
  /** The model id reported by the stream, if any. */
  model: string | null;
  /** True if a terminal `result` event was seen. */
  sawResult: boolean;
  /** The `result` subtype when present ("success" / "error_*"). */
  resultSubtype: string | null;
  /** `total_cost_usd` from the result event, when present. */
  totalCostUsd: number | null;
  /**
   * The ordered intermediate transcript: every assistant `text` / `tool_use`
   * block and every `user` `tool_result`, in stream order. Persisted as
   * `spawn_events` so the Node Inspector can replay the node's real reasoning +
   * tool calls (not just a count). Empty when the stream had no acting steps.
   */
  steps: ClaudeStreamStep[];
}

interface UsageLike {
  input_tokens?: number;
  output_tokens?: number;
  /** OpenAI-style alias for `input_tokens` (some gateways report this name). */
  prompt_tokens?: number;
  /** OpenAI-style alias for `output_tokens`. */
  completion_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Input component of a usage object: `input_tokens` or its `prompt_tokens` alias. */
function usageInput(u: UsageLike | undefined | null): number {
  if (!u) return 0;
  return u.input_tokens ?? u.prompt_tokens ?? 0;
}

/** Output component of a usage object: `output_tokens` or its `completion_tokens` alias. */
function usageOutput(u: UsageLike | undefined | null): number {
  if (!u) return 0;
  return u.output_tokens ?? u.completion_tokens ?? 0;
}

function usageTotal(u: UsageLike | undefined | null): number {
  if (!u) return 0;
  return (
    usageInput(u) +
    usageOutput(u) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0)
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Extract the ordered intermediate steps from ONE parsed stream-json event
 * (an `assistant` turn's content blocks, or a `user` turn's tool_result blocks).
 * Shared by the batch {@link parseClaudeStreamJson} and the LIVE line-by-line
 * worker so both produce identical step shapes — the worker assigns `seq` itself
 * (a running counter) since it sees events one at a time (DESIGN §8.5).
 *
 * Returns steps WITHOUT a `seq` (the caller assigns it). Empty for any other
 * event type (system/result/etc.).
 */
export function stepsFromEvent(
  event: Record<string, unknown>,
): Array<Omit<ClaudeStreamStep, "seq">> {
  const out: Array<Omit<ClaudeStreamStep, "seq">> = [];
  const type = event.type;
  if (type === "assistant") {
    const message = asRecord(event.message);
    const content = message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = asRecord(block);
        if (!b) continue;
        if (b.type === "tool_use") {
          out.push({
            type: "tool_use",
            name: typeof b.name === "string" ? b.name : undefined,
            toolUseId: typeof b.id === "string" ? b.id : undefined,
            input: b.input ?? null,
          });
        } else if (
          b.type === "text" &&
          typeof b.text === "string" &&
          b.text.trim()
        ) {
          out.push({ type: "text", text: b.text });
        }
      }
    }
  } else if (type === "user") {
    const message = asRecord(event.message);
    const content = message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = asRecord(block);
        if (!b || b.type !== "tool_result") continue;
        out.push({
          type: "tool_result",
          toolUseId:
            typeof b.tool_use_id === "string" ? b.tool_use_id : undefined,
          result: b.content ?? null,
        });
      }
    }
  }
  return out;
}

/**
 * Parse a full claude stream-json transcript (the concatenated stdout). Lenient:
 * blank lines and non-JSON lines are skipped (the CLI may interleave the odd
 * non-JSON warning), so a partial/garbled stream still yields best-effort totals
 * rather than throwing.
 */
export function parseClaudeStreamJson(raw: string): ClaudeStreamParseResult {
  let toolCallCount = 0;
  let finalText = "";
  let model: string | null = null;
  let sawResult = false;
  let resultSubtype: string | null = null;
  let totalCostUsd: number | null = null;
  let resultUsage = 0;
  let summedAssistantUsage = 0;
  // FINAL-cumulative input/output split (F7). Streaming usage is cumulative per
  // chunk, so we OVERWRITE (not add) on every usage-bearing event and keep the
  // last value seen — the terminal `result` event wins when present.
  let resultInput = 0;
  let resultOutput = 0;
  let lastInput = 0;
  let lastOutput = 0;
  const steps: ClaudeStreamStep[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let event: Record<string, unknown> | null;
    try {
      event = asRecord(JSON.parse(trimmed));
    } catch {
      continue; // skip non-JSON noise
    }
    if (!event) continue;
    const type = event.type;

    if (type === "assistant" || type === "user") {
      const message = asRecord(event.message);
      if (type === "assistant" && message) {
        if (typeof message.model === "string") model = message.model;
        // Last non-empty assistant text wins as the finalText.
        const content = message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = asRecord(block);
            if (!b) continue;
            if (b.type === "tool_use") toolCallCount += 1;
            else if (b.type === "text" && typeof b.text === "string") {
              finalText = b.text;
            }
          }
        }
        summedAssistantUsage += usageTotal(message.usage as UsageLike);
        // Track the FINAL cumulative split (overwrite, never sum). Only update
        // when this message actually carries usage so a usage-less chunk can't
        // clobber a prior value back to 0.
        const msgUsage = message.usage as UsageLike | undefined;
        if (msgUsage) {
          lastInput = usageInput(msgUsage);
          lastOutput = usageOutput(msgUsage);
        }
      }
      // Append this event's steps with running seq (shared extractor).
      for (const s of stepsFromEvent(event)) {
        steps.push({ seq: steps.length, ...s });
      }
    } else if (type === "result") {
      sawResult = true;
      if (typeof event.subtype === "string") resultSubtype = event.subtype;
      if (typeof event.result === "string") finalText = event.result;
      if (typeof event.total_cost_usd === "number") {
        totalCostUsd = event.total_cost_usd;
      }
      resultUsage = usageTotal(event.usage as UsageLike);
      resultInput = usageInput(event.usage as UsageLike);
      resultOutput = usageOutput(event.usage as UsageLike);
    } else if (type === "system") {
      const m = event.model;
      if (typeof m === "string") model = m;
    }
  }

  // The result event's usage is cumulative; prefer it when present.
  const tokensSpent =
    sawResult && resultUsage > 0 ? resultUsage : summedAssistantUsage;

  // The input/output split is the single FINAL cumulative value — prefer the
  // terminal result event's usage, else the last per-message usage seen. Never
  // a sum across chunks (that would quadratically inflate a cumulative stream).
  const tokensInput = resultInput > 0 ? resultInput : lastInput;
  const tokensOutput = resultOutput > 0 ? resultOutput : lastOutput;

  return {
    tokensSpent,
    tokensInput,
    tokensOutput,
    toolCallCount,
    finalText,
    model,
    sawResult,
    resultSubtype,
    totalCostUsd,
    steps,
  };
}
