/**
 * Brain-driven second-level fan-out routing (docs/CHIEF_OF_STAFF_DESIGN.md §6 /
 * docs/IMPLEMENTATION_PLAN.md §1.5.16, Phase B3).
 *
 * Brain is both a source and a router. Before fanning out to the downstream
 * specialist apps, `compile-briefing` asks the brain agent to run its
 * `search-everything` action and report the resulting
 * `federatedCoverage.delegationHints` — a deterministic, relevance-ranked list
 * of which sibling apps own the data behind the current focus
 * (`templates/brain/server/lib/search.ts:777-792`). We parse those hints,
 * intersect them with the agents we actually discovered, drop any app that is
 * already a first-level target, and hand the remainder back as second-level
 * fan-out targets.
 *
 * Design constraints (kept deliberately narrow):
 *   - Cross-app calls only ever go through `invokeAgent` (§10 hard constraint 1);
 *     brain's `delegationHints` are advisory routing metadata, never a fetch.
 *   - This helper does NOT call `runFanout` — it only resolves the *targets*.
 *     The caller (`compile-briefing`) runs the second-level `runFanout`, so the
 *     `runFanout` primitive stays unpolluted (§1.5.6).
 *   - Brain never delegates to `calendar` or to `brain` itself
 *     (`FEDERATED_DELEGATION_TARGETS` = analytics | mail | dispatch). Those
 *     stay on the first-level fan-out path; this is purely additive.
 *   - Failure is non-fatal: a brain routing error/timeout returns no extra
 *     targets and an `error` note, never throws, so the main fan-out continues.
 *
 * `invoke` / `resolveAuth` are injectable so tests can drive behavior without a
 * live A2A network (mirrors `runFanout`).
 */

import { invokeAgent, resolveA2ACallerAuth } from "@agent-native/core/a2a";
import type { DiscoveredAgent } from "@agent-native/core/server/agent-discovery";

/** One delegation hint as emitted by brain's `federatedCoverage` (subset). */
export interface BrainDelegationHint {
  appId: string;
  matchedSignals?: string[];
}

export interface RouteViaBrainOptions {
  /** This app's id, forwarded to `invokeAgent` for self-call protection. */
  selfAppId: string;
  /** A search/routing focus — the briefing focus, or a generic "today" phrase. */
  focus: string;
  /** Every agent we discovered, so hints can be intersected with reality. */
  discovered: DiscoveredAgent[];
  /** App ids already in the first-level fan-out (excluded from the result). */
  alreadyWanted: string[];
  /** Hard timeout for the brain routing leg in milliseconds. */
  timeoutMs?: number;
  /** Injection point for tests; defaults to the real `invokeAgent`. */
  invoke?: typeof invokeAgent;
  /** Injection point for tests; defaults to the real `resolveA2ACallerAuth`. */
  resolveAuth?: typeof resolveA2ACallerAuth;
}

export interface RouteViaBrainResult {
  /** Second-level fan-out targets resolved from brain's delegation hints. */
  targets: DiscoveredAgent[];
  /** The raw app ids brain suggested, in first-seen order (pre-intersection). */
  suggestedAppIds: string[];
  /** Populated when the brain routing leg failed; the caller logs/notes it. */
  error?: string;
}

/** Default hard ceiling for the brain routing leg (ms). */
export const BRAIN_ROUTE_TIMEOUT_MS = 35_000;

/** The natural-language ask that drives brain to emit its delegation hints. */
export function buildBrainRoutePrompt(focus: string): string {
  const trimmed = focus.trim() || "what needs my attention today";
  return (
    `I'm compiling a cross-app briefing. Call search-everything for ` +
    `"${trimmed}" and look at its federatedCoverage.delegationHints. Reply with ` +
    `ONLY a JSON array of the delegation hints you got, each as ` +
    `{"appId": "...", "matchedSignals": ["..."]}, ordered most relevant first. ` +
    `If there are no delegation hints, reply with an empty array []. Do not add ` +
    `any prose around the JSON.`
  );
}

/**
 * Extract a `delegationHints`-shaped array from the brain agent's reply text.
 * The agent is asked for raw JSON, but real replies sometimes wrap it in prose
 * or a ```json fence — so we scan for the first balanced JSON array of objects
 * and parse that. Returns app ids in first-seen order, de-duplicated. Pure.
 */
export function parseDelegationAppIds(responseText: string): string[] {
  const array = extractFirstJsonArray(responseText);
  if (!array) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(array);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const appId = (entry as { appId?: unknown }).appId;
    if (typeof appId !== "string") continue;
    const cleaned = appId.trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

/**
 * Find the first balanced top-level JSON array in `text` (depth-aware so nested
 * arrays inside objects don't end it early; string-aware so brackets inside
 * string literals are ignored). Returns the substring or null.
 */
function extractFirstJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Ask the brain agent to route, then resolve second-level fan-out targets:
 * suggested app ids ∩ discovered agents, minus apps already in the first-level
 * fan-out. Never throws — a failed brain leg yields `{ targets: [], error }`.
 */
export async function routeViaBrain(
  opts: RouteViaBrainOptions,
): Promise<RouteViaBrainResult> {
  const {
    selfAppId,
    focus,
    discovered,
    alreadyWanted,
    timeoutMs = BRAIN_ROUTE_TIMEOUT_MS,
    invoke = invokeAgent,
    resolveAuth = resolveA2ACallerAuth,
  } = opts;

  let suggestedAppIds: string[] = [];
  try {
    const auth = await resolveAuth();
    const result = await invoke({
      target: "brain",
      selfAppId,
      prompt: buildBrainRoutePrompt(focus),
      apiKey: auth.apiKey,
      userEmail: auth.userEmail,
      orgDomain: auth.orgDomain,
      orgSecret: auth.orgSecret,
      async: true,
      timeoutMs,
    });
    suggestedAppIds = parseDelegationAppIds(result.responseText);
  } catch (err: unknown) {
    return {
      targets: [],
      suggestedAppIds: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const exclude = new Set([...alreadyWanted, selfAppId, "brain"]);
  const byId = new Map(discovered.map((a) => [a.id, a]));
  const seen = new Set<string>();
  const targets: DiscoveredAgent[] = [];
  for (const appId of suggestedAppIds) {
    if (exclude.has(appId) || seen.has(appId)) continue;
    const agent = byId.get(appId);
    if (!agent) continue;
    seen.add(appId);
    targets.push(agent);
  }

  return { targets, suggestedAppIds };
}
