/**
 * Briefing fan-out primitive.
 *
 * `runFanout` asks several sibling app agents, in parallel, "what needs my
 * attention today" and returns one `BriefingSource` per target. It is the
 * reusable orchestration core (docs/IMPLEMENTATION_PLAN.md §1.5.6): the
 * `compile-briefing` action calls it today, and a future orchestrator can call
 * it unchanged.
 *
 * Contract (§1.5.5 / §1.5.6):
 *   - Identity is signed INSIDE runFanout via `resolveA2ACallerAuth()` (a 30m
 *     JWT). Callers do not pass auth.
 *   - Every leg passes `selfAppId` so the A2A self-call guard can fire — without
 *     it, putting yourself in `targets` would recurse (§1.5.5).
 *   - `Promise.allSettled` runs all legs in parallel; one failing app never
 *     aborts the others.
 *   - Per-leg outcome maps to a `BriefingSource.status`:
 *       discovered + replied        → "ok"
 *       exceeded perAppTimeoutMs     → "timeout"
 *       self-call (target == self)   → "skipped" (we don't ask ourselves; §1.5.18)
 *       any other AgentInvocationError / rejection → "error"
 *   - `latencyMs` is wall-clock around the invoke.
 *   - `responseText` is capped at MAX_PER_SOURCE_CHARS and marked when cut.
 *   - `deepLinks` are extracted from an ok reply, scoped to the source app's
 *     own origin (§1.5.12); other statuses carry an empty list.
 *
 * `invoke` / `resolveAuth` are injectable so tests can drive behavior without a
 * live A2A network; defaults are the real core primitives.
 */

import {
  invokeAgent,
  resolveA2ACallerAuth,
  AgentInvocationError,
} from "@agent-native/core/a2a";
import type { DiscoveredAgent } from "@agent-native/core/server/agent-discovery";
import type { BriefingSource } from "./types.js";
import { truncateSourceText } from "./limits.js";
import { extractDeepLinks } from "./deep-links.js";

/** Default hard ceiling for a single app's fan-out leg (ms). */
export const PER_APP_TIMEOUT_MS = 35_000;

/** Raised by the per-leg timeout wrapper so we can map it to `status:"timeout"`. */
export class FanoutTimeoutError extends Error {
  constructor(
    public readonly appId: string,
    public readonly timeoutMs: number,
  ) {
    super(`Fan-out to "${appId}" timed out after ${timeoutMs}ms`);
    this.name = "FanoutTimeoutError";
  }
}

export interface RunFanoutOptions {
  /** This app's id, passed to every `invokeAgent` leg for self-call protection. */
  selfAppId: string;
  /** Already-discovered + filtered targets to fan out to. */
  targets: DiscoveredAgent[];
  /** Builds the natural-language prompt for a given app id. */
  buildPrompt: (appId: string) => string;
  /** Per-leg hard timeout in milliseconds. */
  perAppTimeoutMs?: number;
  /** Injection point for tests; defaults to the real `invokeAgent`. */
  invoke?: typeof invokeAgent;
  /** Injection point for tests; defaults to the real `resolveA2ACallerAuth`. */
  resolveAuth?: typeof resolveA2ACallerAuth;
}

/** Reject with `FanoutTimeoutError` if `promise` does not settle within `ms`. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  appId: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new FanoutTimeoutError(appId, ms)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Build the capped `responseText` for an "ok" leg. */
function cappedResponse(text: string): string {
  return truncateSourceText(text).text;
}

/**
 * Fan out to every target in parallel and collect one `BriefingSource` each.
 * Never throws for a single failed leg — failures become source rows.
 */
export async function runFanout(
  opts: RunFanoutOptions,
): Promise<BriefingSource[]> {
  const {
    selfAppId,
    targets,
    buildPrompt,
    perAppTimeoutMs = PER_APP_TIMEOUT_MS,
    invoke = invokeAgent,
    resolveAuth = resolveA2ACallerAuth,
  } = opts;

  // Sign the 30m caller JWT once and forward it to every leg (§1.5.6 / D3).
  const auth = await resolveAuth();

  const settled = await Promise.allSettled(
    targets.map(async (t): Promise<BriefingSource> => {
      const prompt = buildPrompt(t.id);
      const startedAt = Date.now();
      try {
        const result = await withTimeout(
          invoke({
            target: t.id,
            selfAppId,
            prompt,
            apiKey: auth.apiKey,
            userEmail: auth.userEmail,
            orgDomain: auth.orgDomain,
            orgSecret: auth.orgSecret,
            async: true,
            timeoutMs: perAppTimeoutMs,
          }),
          perAppTimeoutMs,
          t.id,
        );
        const responseText = cappedResponse(result.responseText);
        return {
          app: t.id,
          prompt,
          responseText,
          // Pull app-scoped deep links out of the reply (§1.5.12). Use the raw
          // reply (not the capped copy) so a link near the cut boundary isn't
          // lost; the panel renders these as "Open in <app>" buttons.
          deepLinks: extractDeepLinks(result.responseText, t.url),
          status: "ok",
          latencyMs: Date.now() - startedAt,
        };
      } catch (err: unknown) {
        const latencyMs = Date.now() - startedAt;
        if (err instanceof FanoutTimeoutError) {
          return {
            app: t.id,
            prompt,
            responseText: "",
            deepLinks: [],
            status: "timeout",
            error: err.message,
            latencyMs,
          };
        }
        // Self-call: the target normalized to selfAppId, so invokeAgent threw
        // synchronously before any network call (invoke.ts:107-111). This is an
        // expected "don't ask ourselves" skip, not a failure — record it as
        // `skipped`, never `error`, and never recurse (§1.5.5 / §1.5.18).
        if (err instanceof AgentInvocationError && err.code === "self-call") {
          return {
            app: t.id,
            prompt,
            responseText: "",
            deepLinks: [],
            status: "skipped",
            error: fanoutErrorMessage(err),
            latencyMs,
          };
        }
        return {
          app: t.id,
          prompt,
          responseText: "",
          deepLinks: [],
          status: "error",
          error: fanoutErrorMessage(err),
          latencyMs,
        };
      }
    }),
  );

  // Every leg's map callback returns (never rejects), so allSettled entries are
  // all "fulfilled". Guard the rejected branch defensively all the same.
  return settled.map((entry, i) => {
    if (entry.status === "fulfilled") return entry.value;
    const t = targets[i];
    return {
      app: t.id,
      prompt: buildPrompt(t.id),
      responseText: "",
      deepLinks: [],
      status: "error",
      error: fanoutErrorMessage(entry.reason),
      latencyMs: 0,
    };
  });
}

/** Best-effort human message for a rejected leg. */
function fanoutErrorMessage(err: unknown): string {
  if (err instanceof AgentInvocationError) {
    return `${err.code}: ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
