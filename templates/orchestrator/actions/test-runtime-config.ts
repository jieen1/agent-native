import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { runAgentLoop, type AgentChatEvent } from "@agent-native/core/server";
import { createAISDKEngine } from "@agent-native/core/agent/engine";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";

// test-runtime-config (DESIGN §8.3 item2). A ONE-SHOT REAL test of a saved
// runtime — parity with the Claude Code "Test run". It actually hits the
// network: it resolves the framework's built-in `ai-sdk:openai` engine pointed
// at the saved row's baseUrl (the SAME engine vLLM activation uses — never a
// custom engine, §8.5.1) and runs a tiny "reply with OK" completion through
// `runAgentLoop` (no tools, no microVM).
//
// HONESTY: it returns the REAL completion text on success, or the REAL
// connection/HTTP error on failure — never a fabricated "success". The error is
// returned in a STRUCTURED `{ ok:false, error }` payload (not thrown) so the
// real message reaches the Settings UI; action-routes genericize thrown errors
// to "Internal server error".

/** vLLM ignores the key but the OpenAI SDK requires a non-empty one. Fake placeholder. */
const PLACEHOLDER_KEY = "sk-vllm-local";

/** A short, deterministic probe prompt — cheap, model-independent. */
const PROBE_PROMPT = "Reply with exactly the two characters: OK. Nothing else.";

export default defineAction({
  description:
    "Test a saved vLLM / OpenAI-compatible runtime: resolve its engine + run a tiny real completion against its base URL. Returns the real model reply or the real connection error.",
  schema: z.object({
    id: z.string(),
    timeoutMs: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  }),
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

    const fail = (error: string) => ({
      ok: false as const,
      output: null,
      error,
      model: null as string | null,
      baseUrl: null as string | null,
    });

    const db = getDb();
    const rows = await db
      .select()
      .from(schema.runtimeConfigs)
      .where(
        and(
          eq(schema.runtimeConfigs.id, args.id),
          eq(schema.runtimeConfigs.ownerEmail, ownerEmail),
        ),
      )
      .limit(1);
    const rt = rows[0];
    if (!rt) return fail(`Runtime ${args.id} not found.`);

    if (rt.kind === "claude-code") {
      return fail(
        "This is a Claude Code runtime — use the Claude Code “Test run” instead.",
      );
    }
    if (!rt.baseUrl || rt.baseUrl.trim() === "") {
      return fail("This runtime has no base URL to test.");
    }

    const baseUrl = rt.baseUrl.trim();
    const model = (rt.model && rt.model.trim()) || "";
    if (model === "") {
      return fail(
        "This runtime has no model set — add a model id (e.g. the served model name) and retry.",
      );
    }

    // Built-in `ai-sdk:openai` with a custom baseUrl → OpenAI chat-completions
    // against the endpoint (DESIGN §8.2). `allowEnvFallback:false` keeps this
    // request-scoped test from leaking the host process env's real OpenAI key
    // into a local endpoint call.
    const engine = createAISDKEngine("openai", {
      apiKey: PLACEHOLDER_KEY,
      baseUrl,
      model,
      allowEnvFallback: false,
    });

    // Capture the streamed assistant text + any structured error event.
    let text = "";
    let streamError = "";
    const send = (event: AgentChatEvent): void => {
      if (event.type === "text" && typeof event.text === "string") {
        text += event.text;
      } else if (event.type === "error") {
        streamError = String(
          (event as { error?: unknown }).error ?? "engine error",
        );
      }
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), args.timeoutMs);
    try {
      await runAgentLoop({
        engine,
        model,
        systemPrompt: "You are a connectivity probe. Answer in one short line.",
        tools: [],
        actions: {},
        messages: [
          { role: "user", content: [{ type: "text", text: PROBE_PROMPT }] },
        ],
        send,
        signal: controller.signal,
        ownerEmail,
        maxIterations: 1,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const aborted = controller.signal.aborted;
      return fail(
        aborted
          ? `Timed out after ${args.timeoutMs}ms contacting ${baseUrl}. Is the endpoint reachable and serving “${model}”?`
          : `Could not reach ${baseUrl}: ${msg}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (streamError) {
      return fail(`Endpoint returned an error: ${streamError}`);
    }

    const reply = text.trim();
    if (reply === "") {
      return fail(
        `Reached ${baseUrl} but “${model}” returned no text. Confirm the model id is served by this endpoint.`,
      );
    }

    return {
      ok: true as const,
      output: reply,
      error: null as string | null,
      model,
      baseUrl,
    };
  },
});
