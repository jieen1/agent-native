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

/** Aggregated outcome of parsing a claude stream-json transcript. */
export interface ClaudeStreamParseResult {
  /** Total tokens (input + output + cache read + cache write). */
  tokensSpent: number;
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
}

interface UsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function usageTotal(u: UsageLike | undefined | null): number {
  if (!u) return 0;
  return (
    (u.input_tokens ?? 0) +
    (u.output_tokens ?? 0) +
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

    if (type === "assistant") {
      const message = asRecord(event.message);
      if (message) {
        if (typeof message.model === "string") model = message.model;
        const content = message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = asRecord(block);
            if (!b) continue;
            if (b.type === "tool_use") toolCallCount += 1;
            else if (b.type === "text" && typeof b.text === "string") {
              finalText = b.text; // last assistant text wins
            }
          }
        }
        summedAssistantUsage += usageTotal(message.usage as UsageLike);
      }
    } else if (type === "result") {
      sawResult = true;
      if (typeof event.subtype === "string") resultSubtype = event.subtype;
      if (typeof event.result === "string") finalText = event.result;
      if (typeof event.total_cost_usd === "number") {
        totalCostUsd = event.total_cost_usd;
      }
      resultUsage = usageTotal(event.usage as UsageLike);
    } else if (type === "system") {
      const m = event.model;
      if (typeof m === "string") model = m;
    }
  }

  // The result event's usage is cumulative; prefer it when present.
  const tokensSpent =
    sawResult && resultUsage > 0 ? resultUsage : summedAssistantUsage;

  return {
    tokensSpent,
    toolCallCount,
    finalText,
    model,
    sawResult,
    resultSubtype,
    totalCostUsd,
  };
}
