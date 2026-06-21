/**
 * Deterministic single-step executor (Phase A4 §1.5.10).
 *
 * A deterministic routine runs ONE fixed action with no LLM in the loop — no
 * `runAgentLoop`, no Haiku classifier, no model call at all. Its declaration is
 * a single fenced ```json block in the routine body (the same body the agentic
 * path otherwise feeds to the model as a prompt). This executor is shared by
 * both trigger paths: the cron scheduler (`jobs/scheduler.ts`) and the event
 * dispatcher (`triggers/dispatcher.ts`).
 *
 * Two kinds are supported:
 *   - `web-request`: an outbound HTTP call, executed through the already-wired
 *     `web-request` fetch-tool entry passed in `ctx.actions`. That entry owns
 *     `${keys.NAME}` substitution, SSRF blocking, and per-key URL allowlisting —
 *     this executor never re-implements any of it.
 *   - `action`: a named, already-registered action, called by name with its
 *     declared `params`. Identity (run-as user / org) is carried by the ambient
 *     `runWithRequestContext` the caller establishes, so no per-call context is
 *     threaded here (same mechanism the agentic path relies on).
 *
 * The Zod schema (`deterministicStepSchema`) is the single source of truth for a
 * valid declaration. It is exported (via `triggers/index.ts`) so the Routines
 * `save-routine` action validates with the exact same schema the executor parses
 * with — an illegal declaration is rejected at save time and never reaches here.
 */

import { z } from "zod";
import type { ActionEntry } from "../agent/production-agent.js";

/**
 * Single-step declaration schema (§1.5.10, fixed). A declaration is exactly one
 * object — a discriminated union on `kind`, so a multi-step array is rejected
 * structurally (an array is not an object with a `kind`). `.strict()` rejects
 * unknown fields so a typo'd key surfaces as a validation error rather than
 * being silently dropped.
 */
export const deterministicStepSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("web-request"),
      method: z
        .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
        .default("GET"),
      url: z.string().min(1),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("action"),
      action: z.string().min(1),
      params: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
]);

export type DeterministicStepDecl = z.infer<typeof deterministicStepSchema>;

export interface DeterministicStepContext {
  /** The live action registry (= `deps.getActions()`), including `web-request`. */
  actions: Record<string, ActionEntry>;
  /** Thread id for the run, surfaced for parity with the agentic path. */
  threadId?: string;
}

export interface DeterministicStepResult {
  kind: "web-request" | "action";
  output: unknown;
}

// First fenced code block, optionally tagged `json`. Tolerant of leading
// whitespace and a trailing newline before the closing fence.
const FENCE_RE = /```(?:json)?\s*\n([\s\S]*?)\n```/;

/**
 * Extract and validate the single-step declaration from a routine body.
 *
 * The declaration is the first fenced ```json block; a bare JSON body (no
 * fence) is tolerated so a declaration that was stored without fencing still
 * parses. Throws on malformed JSON or a schema-invalid declaration — but the
 * primary guard is `save-routine` (the same schema), so a live routine should
 * never carry an invalid declaration.
 */
export function parseDeterministicStep(body: string): DeterministicStepDecl {
  const match = body.match(FENCE_RE);
  const raw = match ? match[1] : body.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Deterministic routine body is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return deterministicStepSchema.parse(parsed);
}

/**
 * Execute one deterministic step. Pure (no DB writes, no scheduling) — the
 * caller owns `routine_runs` bookkeeping and the `runWithRequestContext`
 * identity wrapper. Never starts an agent loop or calls an LLM.
 */
export async function runDeterministicStep(
  body: string,
  ctx: DeterministicStepContext,
): Promise<DeterministicStepResult> {
  const decl = parseDeterministicStep(body);

  if (decl.kind === "web-request") {
    const webRequest = ctx.actions["web-request"];
    if (!webRequest) {
      throw new Error(
        "web-request tool is unavailable in this runtime — cannot run a deterministic web-request step.",
      );
    }
    // The fetch-tool entry owns ${keys} substitution, SSRF blocking, and
    // allowlist validation. It accepts a JSON string OR an object for headers;
    // we pass the declared record as a JSON string (most robust).
    const output = await webRequest.run({
      url: decl.url,
      method: decl.method,
      headers: decl.headers ? JSON.stringify(decl.headers) : undefined,
      body: decl.body,
    });
    return { kind: "web-request", output };
  }

  // kind === "action": call the named, already-registered action with its
  // declared params. Identity flows through the ambient request context, so we
  // do not thread a per-call context (parity with the agentic tool path).
  const entry = ctx.actions[decl.action];
  if (!entry) {
    throw new Error(`Unknown action: "${decl.action}"`);
  }
  const output = await entry.run(decl.params ?? {});
  return { kind: "action", output };
}
