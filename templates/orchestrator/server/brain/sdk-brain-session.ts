// SDK brain session — replaces the `claude -p` child with an AI SDK agent loop
// against the local vLLM relay (or any OpenAI-compatible endpoint). Uses the
// @modelcontextprotocol/sdk StreamableHTTPClientTransport to discover and call
// orchestrator tools from the live MCP endpoint, exactly as Claude Code does,
// without requiring the CC CLI binary or OAuth credentials.
//
// Called when getManagedClaudeStatus().loggedIn is false and an OpenAI-
// compatible endpoint is configured (OPENAI_BASE_URL or a saved vllm runtime).
//
// Tool loop: up to MAX_STEPS tool rounds. Each round calls generateText, emits
// events to brain_events, and feeds results back. Terminates when the model
// returns with no tool calls or MAX_STEPS is reached.

import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import { getV3Db, v3Schema } from "../db/index.js";
import { mintBrainToken } from "./brain-mcp-config.js";
import { BRAIN_PROMPT } from "./brain-prompt.js";

const MCP_URL = "http://localhost:3002/_agent-native/mcp";
const MAX_STEPS = 50;
const VLLM_BASE_URL =
  process.env.OPENAI_BASE_URL?.trim() || "http://192.168.1.250:9000/v1";
const VLLM_MODEL = process.env.OPENAI_MODEL?.trim() || "claude-sonnet-4-6";
const VLLM_API_KEY = process.env.OPENAI_API_KEY?.trim() || "sk-vllm-local";

interface AppendEventInput {
  type: string;
  text?: string | null;
  toolName?: string | null;
  toolUseId?: string | null;
  toolInput?: unknown;
  toolResult?: unknown;
}

// Postgres text AND jsonb reject the NUL byte (U+0000); strip it (deep) from
// every persisted value so no tool_result file content can crash the transcript.
function stripNul<T>(value: T): T {
  if (typeof value === "string") {
    // eslint-disable-next-line no-control-regex
    return value.replace(/\u0000/g, "") as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => stripNul(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = stripNul(v);
    }
    return out as unknown as T;
  }
  return value;
}

async function appendEvent(
  threadId: string,
  ownerEmail: string,
  orgId: string | null,
  input: AppendEventInput,
): Promise<void> {
  const db = getV3Db();
  const [{ next }] = await db
    .select({
      next: sql<number>`coalesce(max(${v3Schema.brainEvents.seq}), -1) + 1`.mapWith(
        Number,
      ),
    })
    .from(v3Schema.brainEvents)
    .where(eq(v3Schema.brainEvents.threadId, threadId));

  await db.insert(v3Schema.brainEvents).values({
    id: `be_${randomUUID()}`,
    threadId,
    seq: next,
    type: input.type,
    // Strip NUL bytes: Postgres text/jsonb reject U+0000, and tool_results
    // carry raw file content that may contain one.
    text: input.text != null ? stripNul(input.text) : null,
    toolName: input.toolName ?? null,
    toolUseId: input.toolUseId ?? null,
    toolInput: input.toolInput != null ? stripNul(input.toolInput) : null,
    toolResult: input.toolResult != null ? stripNul(input.toolResult) : null,
    ownerEmail,
    orgId,
  });
}

/** Call the orchestrator MCP endpoint via JSON-RPC to list available tools. */
async function mcpListTools(
  bearer: string,
): Promise<
  Array<{ name: string; description?: string; inputSchema: unknown }>
> {
  const resp = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });

  if (!resp.ok) {
    throw new Error(`MCP tools/list failed: ${resp.status} ${resp.statusText}`);
  }

  const ct = resp.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream")) {
    // Parse SSE stream to find the result event
    const text = await resp.text();
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt?.result?.tools) return evt.result.tools;
        } catch {
          // skip non-JSON lines
        }
      }
    }
    throw new Error("No tools found in SSE response from MCP");
  }

  const data = (await resp.json()) as {
    result?: {
      tools?: Array<{
        name: string;
        description?: string;
        inputSchema: unknown;
      }>;
    };
    error?: { message: string };
  };
  if (data.error) throw new Error(`MCP error: ${data.error.message}`);
  return data.result?.tools ?? [];
}

/** Call a single orchestrator MCP tool. */
async function mcpCallTool(
  bearer: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const resp = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });

  if (!resp.ok) {
    throw new Error(
      `MCP tools/call ${name} failed: ${resp.status} ${resp.statusText}`,
    );
  }

  const ct = resp.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream")) {
    const text = await resp.text();
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt?.result !== undefined) return evt.result;
        } catch {
          // skip
        }
      }
    }
    throw new Error(`No result in SSE response for tool ${name}`);
  }

  const data = (await resp.json()) as {
    result?: { content?: Array<{ type: string; text?: string }> };
    error?: { message: string };
  };
  if (data.error)
    throw new Error(`MCP tool ${name} error: ${data.error.message}`);
  // MCP result: array of content items, extract text
  const content = data.result?.content ?? [];
  if (content.length === 1 && content[0].type === "text") {
    try {
      return JSON.parse(content[0].text ?? "null");
    } catch {
      return content[0].text;
    }
  }
  return content;
}

/**
 * A deliberate brain-model override resolved to a saved `runtime_configs` row
 * (`server/brain/brain-runtime.ts`'s `getBrainRuntimeSelection`). When
 * present, it takes precedence over the module-level env-var-derived
 * VLLM_BASE_URL/VLLM_MODEL/VLLM_API_KEY constants below — omitting it
 * preserves the EXACT existing automatic-fallback behavior (CC-logged-out
 * safety net), byte for byte.
 */
export interface SdkBrainRuntimeOverride {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** The runtime_configs row's saved name, for transcript/log honesty. */
  name?: string;
}

interface SdkBrainOpts {
  threadId: string;
  ownerEmail: string;
  orgId: string | null;
  message: string;
  runtimeOverride?: SdkBrainRuntimeOverride;
}

export interface SdkBrainOutcome {
  ok: boolean;
  error?: string;
}

/**
 * Run one SDK brain turn: discovers orchestrator tools from the MCP endpoint,
 * runs an AI SDK generateText agentic loop against the vLLM relay, and stores
 * events in brain_events. Non-blocking: this function DOES await completion
 * (unlike the CC path which fires a background child). Call it inside a
 * `void promise.catch(...)` to background it the same way.
 */
export async function runSdkBrainTurn(
  opts: SdkBrainOpts,
): Promise<SdkBrainOutcome> {
  const { threadId, ownerEmail, orgId, message, runtimeOverride } = opts;

  // A deliberate runtime override (a saved openai-compatible/vllm
  // runtime_configs row) takes precedence over the env-var-derived defaults;
  // omitting it preserves the EXACT existing automatic-fallback behavior.
  const resolvedBaseUrl = runtimeOverride?.baseUrl.trim() || VLLM_BASE_URL;
  const resolvedModel = runtimeOverride?.model.trim() || VLLM_MODEL;
  const resolvedApiKey = runtimeOverride?.apiKey?.trim() || VLLM_API_KEY;

  // Mint A2A bearer for this owner.
  const bearer = mintBrainToken(ownerEmail);

  // Discover tools from the live MCP endpoint.
  let mcpTools: Array<{
    name: string;
    description?: string;
    inputSchema: unknown;
  }>;
  try {
    mcpTools = await mcpListTools(bearer);
  } catch (err) {
    const msg = `Failed to list MCP tools: ${err instanceof Error ? err.message : String(err)}`;
    await appendEvent(threadId, ownerEmail, orgId, {
      type: "error",
      text: msg,
    });
    return { ok: false, error: msg };
  }

  if (mcpTools.length === 0) {
    const msg =
      "MCP server returned no tools — orchestrator may not be running.";
    await appendEvent(threadId, ownerEmail, orgId, {
      type: "error",
      text: msg,
    });
    return { ok: false, error: msg };
  }

  // Load prior conversation from brain_events for context (resume).
  const db = getV3Db();
  const priorEvents = await db
    .select()
    .from(v3Schema.brainEvents)
    .where(eq(v3Schema.brainEvents.threadId, threadId))
    .orderBy(v3Schema.brainEvents.seq);

  // Build message history from prior events.
  type Message =
    | { role: "system"; content: string }
    | { role: "user"; content: string }
    | {
        role: "assistant";
        content: Array<
          | { type: "text"; text: string }
          | {
              type: "tool-call";
              toolCallId: string;
              toolName: string;
              args: Record<string, unknown>;
            }
        >;
      }
    | {
        role: "tool";
        content: Array<{
          type: "tool-result";
          toolCallId: string;
          toolName: string;
          result: unknown;
        }>;
      };

  const messages: Message[] = [];
  const assistantParts: Array<
    | { type: "text"; text: string }
    | {
        type: "tool-call";
        toolCallId: string;
        toolName: string;
        args: Record<string, unknown>;
      }
  > = [];
  const toolResults: Array<{
    type: "tool-result";
    toolCallId: string;
    toolName: string;
    result: unknown;
  }> = [];

  function flushAssistant() {
    if (assistantParts.length > 0) {
      messages.push({ role: "assistant", content: [...assistantParts] });
      assistantParts.length = 0;
    }
  }
  function flushTools() {
    if (toolResults.length > 0) {
      messages.push({ role: "tool", content: [...toolResults] });
      toolResults.length = 0;
    }
  }

  for (const ev of priorEvents) {
    if (ev.type === "user") {
      flushAssistant();
      flushTools();
      messages.push({ role: "user", content: ev.text ?? "" });
    } else if (ev.type === "assistant") {
      flushTools();
      assistantParts.push({ type: "text", text: ev.text ?? "" });
    } else if (ev.type === "tool_use") {
      flushTools();
      assistantParts.push({
        type: "tool-call",
        toolCallId: ev.toolUseId ?? `tc_${randomUUID()}`,
        toolName: ev.toolName ?? "",
        args: (ev.toolInput ?? {}) as Record<string, unknown>,
      });
    } else if (ev.type === "tool_result") {
      flushAssistant();
      toolResults.push({
        type: "tool-result",
        toolCallId: ev.toolUseId ?? `tc_${randomUUID()}`,
        toolName: ev.toolName ?? "",
        result: ev.toolResult,
      });
    }
  }
  flushAssistant();
  flushTools();

  // Append the current user message to history.
  messages.push({ role: "user", content: message });

  // Build AI SDK tool definitions from MCP tool schemas.
  const tools: Record<string, { description?: string; parameters: unknown }> =
    {};
  for (const t of mcpTools) {
    tools[t.name] = {
      description: t.description,
      parameters: t.inputSchema,
    };
  }

  // Emit a system event so the transcript shows which mode is active — names
  // the actual resolved endpoint/model, and the row name when this turn is a
  // deliberate runtime-override selection rather than the automatic fallback.
  const engineLabel = runtimeOverride
    ? `SDK brain (runtime override${runtimeOverride.name ? `: ${runtimeOverride.name}` : ""})`
    : "SDK brain (vLLM)";
  await appendEvent(threadId, ownerEmail, orgId, {
    type: "system",
    text: `${engineLabel} turn started — model: ${resolvedModel}, endpoint: ${resolvedBaseUrl}, tools: ${mcpTools.length}`,
  });

  // Run the agentic loop.
  let step = 0;
  let currentMessages = [...messages];

  while (step < MAX_STEPS) {
    step++;

    // Dynamic import of ai package (same pattern as ai-sdk-engine.ts).
    let generateText: (opts: unknown) => Promise<{
      text: string;
      toolCalls?: Array<{
        toolCallId: string;
        toolName: string;
        args: Record<string, unknown>;
      }>;
      finishReason: string;
    }>;
    let createOpenAI: (opts: {
      apiKey: string;
      baseURL: string;
    }) => (model: string) => unknown;
    try {
      const ai = await import("ai");
      generateText = ai.generateText as typeof generateText;
      const openaiMod = await import("@ai-sdk/openai");
      createOpenAI = openaiMod.createOpenAI as typeof createOpenAI;
    } catch (err) {
      const msg = `Cannot import ai SDK: ${err instanceof Error ? err.message : String(err)}`;
      await appendEvent(threadId, ownerEmail, orgId, {
        type: "error",
        text: msg,
      });
      return { ok: false, error: msg };
    }

    const openai = createOpenAI({
      apiKey: resolvedApiKey,
      baseURL: resolvedBaseUrl,
    });
    const model = openai(resolvedModel);

    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      result = await generateText({
        model,
        system: BRAIN_PROMPT,
        messages: currentMessages,
        tools,
        maxTokens: 8192,
      });
    } catch (err) {
      const msg = `generateText error (step ${step}): ${err instanceof Error ? err.message : String(err)}`;
      await appendEvent(threadId, ownerEmail, orgId, {
        type: "error",
        text: msg,
      });
      return { ok: false, error: msg };
    }

    // Emit assistant text if present.
    if (result.text?.trim()) {
      await appendEvent(threadId, ownerEmail, orgId, {
        type: "assistant",
        text: result.text,
      });
    }

    // No tool calls → model is done.
    if (!result.toolCalls || result.toolCalls.length === 0) {
      break;
    }

    // Execute each tool call against the MCP endpoint and collect results.
    const toolResultParts: Array<{
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      result: unknown;
    }> = [];
    const assistantCallParts: Array<{
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }> = [];

    for (const tc of result.toolCalls) {
      const useId = tc.toolCallId;
      const name = tc.toolName;
      const args = tc.args ?? {};

      await appendEvent(threadId, ownerEmail, orgId, {
        type: "tool_use",
        toolName: name,
        toolUseId: useId,
        toolInput: args,
      });

      assistantCallParts.push({
        type: "tool-call",
        toolCallId: useId,
        toolName: name,
        args,
      });

      let toolResult: unknown;
      try {
        toolResult = await mcpCallTool(bearer, name, args);
      } catch (err) {
        toolResult = {
          error: err instanceof Error ? err.message : String(err),
        };
      }

      await appendEvent(threadId, ownerEmail, orgId, {
        type: "tool_result",
        toolName: name,
        toolUseId: useId,
        toolResult,
      });

      toolResultParts.push({
        type: "tool-result",
        toolCallId: useId,
        toolName: name,
        result: toolResult,
      });
    }

    // Extend message history: assistant turn with tool calls, then tool results.
    const textPart = result.text?.trim()
      ? [{ type: "text" as const, text: result.text }]
      : [];
    currentMessages = [
      ...currentMessages,
      { role: "assistant", content: [...textPart, ...assistantCallParts] },
      { role: "tool", content: toolResultParts },
    ];

    if (result.finishReason === "stop" || result.finishReason === "end-turn") {
      break;
    }
  }

  if (step >= MAX_STEPS) {
    await appendEvent(threadId, ownerEmail, orgId, {
      type: "system",
      text: `SDK brain reached MAX_STEPS (${MAX_STEPS}) — turn ended.`,
    });
  }

  return { ok: true };
}
