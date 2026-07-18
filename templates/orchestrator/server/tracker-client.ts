// F9 (orchestrator half) — deterministic writeback channel: tracker-client.ts
//
// Design authority: docs/sdlc-impl-f5-f10.md §5 "F9 确定性回写通道" (5A, the
// `server/tracker-client.ts` row) + docs/sdlc-product-design/02-workflows.md
// §6 (回写通道) / §8 (守卫表).
//
// When a V3 run bound to a tracker-dispatched work item reaches a terminal
// state, the orchestrator calls BACK into the tracker over a deterministic,
// signed MCP `tools/call` (NOT the NL A2A loop — see the
// "multi-app-workspace" doc / CLAUDE.md "known justified deviations") to
// report exec-state, backfill run/branch metadata, and advance the item's
// stage. This closes the dispatch loop without the tracker having to poll.
//
// ── Sentinel identity (the "writeback actor") ───────────────────────────────
// The tracker's `server/lib/writeback-actor.ts` (F9, tracker side) admits a
// call ONLY when BOTH factors hold: (a) the MCP surface identifies the caller
// as `caller==="mcp"` (any cross-app `tools/call` lands this way — see
// `packages/core/src/mcp/build-server.ts`'s `tools/call` handler, which always
// sets `caller: "mcp"`), AND (b) the verified JWT's `sub` equals a reserved
// sentinel email (`WRITEBACK_ACTOR_EMAIL`, same env var name + same default
// value `writeback@orchestrator.internal` on BOTH apps — this file and the
// tracker's `writeback-actor.ts` must agree byte-for-byte or the double-factor
// check never passes).
//
// We mint that JWT with `@agent-native/core`'s `signA2AToken` (NOT a hand-
// rolled HMAC like the tracker's own `mcp-client.ts` sibling-app clients use —
// those don't support extra claims, and we need one: `org_id`). The item's
// REAL org id (read off the run's `tags`, which F9's tracker-side
// `dispatch-to-orchestrator.ts`/`bulk-dispatch-to-orchestrator.ts` populate
// with `owner_email`/`org_id` at dispatch time) is carried as an `org_id`
// extra claim. The tracker's `ownerScope()` is an OR of
// `ownerEmail===sub OR orgId===claim` — so `org_id` alone is enough to admit
// the read/write scoped to that work item's row, without requiring `sub` to
// equal the real human owner (see writeback-actor.ts's own doc comment, which
// describes exactly this mechanism from the tracker side).

import { signA2AToken } from "@agent-native/core/a2a";

/** The reserved `sub` value this channel mints into its outbound A2A JWT.
 * MUST match the tracker's `writebackActorEmail()` default/env exactly. */
const DEFAULT_WRITEBACK_ACTOR_EMAIL = "writeback@orchestrator.internal";

export function writebackActorEmail(): string {
  return (
    process.env.WRITEBACK_ACTOR_EMAIL?.trim() || DEFAULT_WRITEBACK_ACTOR_EMAIL
  );
}

/** Base URL of the tracker, reachable from the orchestrator container. Prefer
 * the same-docker-network service hostname; fall back to the gateway route.
 * Override with TRACKER_BASE_URL. Mirrors the tracker's own
 * `orchestratorBaseUrl()` / `contentBaseUrl()` conventions.
 *
 * The fallback port (3013) matches this deployment's real per-app port
 * allocation (an-tracker's own PORT env) — NOT this service's own port
 * (3002, orchestrator's), which the fallback wrongly used before. Because
 * `TRACKER_BASE_URL` was also never set in the orchestrator container's
 * deploy config, every writeback fetch silently dialed the orchestrator
 * container itself instead of the tracker, failing at the network level
 * (`fetch failed`) — the confirmed cause of the writeback-outbox-sweep's
 * 108+ retry drain (`docker exec an-orchestrator env` had no
 * TRACKER_BASE_URL; 101's deploy compose now sets it explicitly — this
 * fallback is only the second line of defense if that ever regresses).
 */
export function trackerBaseUrl(): string {
  return (
    process.env.TRACKER_BASE_URL?.replace(/\/$/, "") || "http://an-tracker:3013"
  );
}

function mcpEndpoint(): string {
  return `${trackerBaseUrl()}/tracker/_agent-native/mcp`;
}

/** Mint the sentinel A2A JWT. `orgId` (when known) rides as an `org_id` extra
 * claim so the tracker's `ownerScope()` OR-admits the call without needing
 * `sub` to equal the item's real owner. Short-lived (5m) — this is minted
 * fresh per writeback call, never cached/reused. */
export async function mintWritebackJwt(orgId: string | null): Promise<string> {
  return signA2AToken(writebackActorEmail(), undefined, undefined, {
    preferGlobalSecret: true,
    expiresIn: "5m",
    extraClaims: orgId ? { org_id: orgId } : undefined,
  });
}

export interface McpCallResult {
  /** Parsed JSON result of the action (from MCP structuredContent or text). */
  data: unknown;
  /** Raw MCP envelope for debugging. */
  raw: unknown;
}

/**
 * Parse an MCP HTTP response body. The stateless transport can return either
 * a JSON body or an SSE frame (`data: <json>`) — parse both. Mirrors the
 * tracker's own `mcp-client.ts` (kept independent — apps never import across
 * the app boundary; see the `multi-app-workspace` doc).
 */
export function parseMcpResponse(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.startsWith("data:")) {
      return JSON.parse(line.slice("data:".length).trim());
    }
  }
  throw new Error(`Unparseable MCP response: ${trimmed.slice(0, 200)}`);
}

/**
 * Call a tracker action by its MCP tool name over JSON-RPC `tools/call`, as
 * the sentinel writeback actor. `orgId` is the item's real org (from run
 * tags) — required for `ownerScope()` to admit the call on the tracker side
 * when the sentinel `sub` doesn't match the item's real owner email.
 */
export async function callTrackerTool(
  orgId: string | null,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const jwt = await mintWritebackJwt(orgId);
  const endpoint = mcpEndpoint();
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${jwt}`,
      // Inert on the verified-JWT path (build-server.ts only consults this
      // header on the static-token/dev-open path) — kept for parity with the
      // tracker's own sibling-app clients and as a debugging breadcrumb.
      "X-Agent-Native-Owner-Email": writebackActorEmail(),
      // packages/core's MCP server defaults EVERY caller to the "compact"
      // tool catalog (server.ts's build of MCPRequestMeta) — a curated
      // subset meant to keep an LLM-driven client's tool list small. A
      // narrow F9 writeback action like `writeback-run-meta` is deliberately
      // NOT in that curated set, so without this header every writeback
      // `tools/call` here failed with "Unknown tool: <name>" — a systemic,
      // all-time-100%-failure bug (958 writeback.failed events, zero
      // successful writebacks ever, confirmed on production 2026-07-18).
      // This channel is a deterministic system-to-system JSON-RPC call, not
      // an LLM tool-list consumer (it never calls tools/list) — the
      // documented opt-in header (mcp/server.ts) is exactly the intended
      // way for a caller like this to reach its own actions regardless of
      // the compact-catalog curation; access control is still fully
      // enforced by each action's own caller check (assertWritebackCaller)
      // and `ownerScope()`, not by hiding the tool name.
      "X-Agent-Native-Mcp-Full-Catalog": "1",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Tracker MCP ${toolName} failed (HTTP ${res.status}): ${text.slice(0, 500)}`,
    );
  }

  const parsed = parseMcpResponse(text);
  const rpc = parsed as {
    error?: { message?: string };
    result?: {
      isError?: boolean;
      structuredContent?: unknown;
      content?: Array<{ type: string; text?: string }>;
    };
  };
  if (rpc.error) {
    throw new Error(`Tracker MCP ${toolName} error: ${rpc.error.message}`);
  }
  const result = rpc.result;
  if (!result) {
    throw new Error(`Tracker MCP ${toolName}: empty result`);
  }
  if (result.isError) {
    const msg = result.content?.find((c) => c.type === "text")?.text;
    throw new Error(`Tracker MCP ${toolName} tool error: ${msg ?? "?"}`);
  }

  let data: unknown = result.structuredContent;
  if (data === undefined) {
    const textPart = result.content?.find((c) => c.type === "text")?.text;
    if (textPart) {
      try {
        data = JSON.parse(textPart);
      } catch {
        data = textPart;
      }
    }
  }
  return { data, raw: parsed };
}

// ── Run tags → writeback identity ───────────────────────────────────────────

export interface RunWritebackTags {
  /** The tracker work item this run was dispatched for (tags.item_id, set by
   * `dispatch-to-orchestrator.ts` today). Absent → this run wasn't a tracker
   * dispatch at all; the caller should skip writeback entirely. */
  workItemId: string | null;
  /** The item's real org id (tags.org_id) — F9 tracker-side
   * `dispatch-to-orchestrator.ts`/`bulk-dispatch-to-orchestrator.ts` populate
   * this at dispatch time. NOTE: at the time this file was written, that tag
   * had not yet landed on this branch's `dispatch-to-orchestrator.ts` (it
   * ships as part of the tracker-side F9 batch on a separate branch) — this
   * reads it defensively and simply returns null when absent, rather than
   * assuming it's always there. */
  orgId: string | null;
}

/** Best-effort tag extraction — tolerant of missing keys, wrong types, or
 * `tags` not being an object at all (e.g. null for a non-tracker run). */
export function parseRunTags(tags: unknown): RunWritebackTags {
  const t =
    tags && typeof tags === "object" ? (tags as Record<string, unknown>) : {};
  const workItemId =
    typeof t.item_id === "string" && t.item_id ? t.item_id : null;
  const orgId = typeof t.org_id === "string" && t.org_id ? t.org_id : null;
  return { workItemId, orgId };
}

// ── Delivery detection (best-effort) ────────────────────────────────────────

const PR_URL_RE = /https?:\/\/[^\s)]+\/pull\/\d+/i;
const BRANCH_RE = /\b(orchestrator\/[A-Za-z0-9._\-/]+)\b/;

/**
 * Scan a run's output-artifact text for a delivered PR URL / branch, the same
 * regex-based approach the tracker's own `get-activity.ts` `extractDelivery`
 * uses over the brain transcript (kept independent — no cross-app import).
 * Best-effort: there is currently no durable "a delivery happened" record
 * (`workspaceCommit`/`workspaceCommitPush` are pure git-mechanics calls — they
 * write no v3_events/artifact of their own), so this is the best signal
 * available without touching workspace-commit code (out of this file's
 * declared scope). Returns `{ branch: null, prUrl: null }` when nothing is
 * found — callers treat that as "zero-delivery".
 */
export function extractDeliveryFromArtifactTexts(
  texts: Array<string | null | undefined>,
): {
  branch: string | null;
  prUrl: string | null;
} {
  let branch: string | null = null;
  let prUrl: string | null = null;
  for (const t of texts) {
    if (typeof t !== "string" || !t) continue;
    if (!prUrl) {
      const m = t.match(PR_URL_RE);
      if (m) prUrl = m[0];
    }
    if (!branch) {
      const m = t.match(BRANCH_RE);
      if (m) branch = m[1] ?? null;
    }
    if (branch && prUrl) break;
  }
  return { branch, prUrl };
}

// ── onRunTerminal ────────────────────────────────────────────────────────────

/**
 * R4a.3 L2 (docs/sdlc-product-design/r4-workflow-families-planning-skills.md
 * §4.4 second bullet) — "brain deviated from the L1 suggestion" receipt.
 * `chosen` is the run's REAL template name (ground truth, resolved from
 * `v3_runs.template_id`); `suggested`/`deviationReason` come from the run's
 * own `tags` (propagated from `dispatch-to-orchestrator.ts`'s L1 suggestion,
 * and — when the brain deviates — a `deviationReason` tag it is instructed to
 * set on its workflowRun call, see brain-send.ts). Leave-a-trace only, not
 * mechanical enforcement (the design is explicit: "留痕+度量, 不是机制性禁止").
 */
export interface TemplateDeviation {
  chosen: string;
  suggested?: string;
  deviationReason?: string;
}

export type WritebackOutcome =
  | {
      kind: "delivered";
      workItemId: string;
      orgId: string | null;
      runId: string;
      branch: string | null;
      /** Present only when the run's tags show an L1 suggestion AND the run
       *  actually used a different template (or the brain explicitly logged
       *  a deviationReason anyway). */
      templateDeviation?: TemplateDeviation;
    }
  | {
      kind: "zero-delivery";
      workItemId: string;
      orgId: string | null;
      runId?: string;
      /** e.g. "run-done-no-delivery" | "run-failed" | "run-cancelled" |
       * "thread-error-no-run" (the last one is the true "brain 首轮零交付"
       * case, whose TRIGGER lives outside this file — see module doc /
       * report). */
      reason: string;
    };

/** Best-effort extraction of the L1/L2 routing tags a run may carry. Tolerant
 *  of missing keys, wrong types, or `tags` not being an object. */
export interface TemplateDeviationTags {
  suggestedTemplate: string | null;
  ruleId: string | null;
  deviationReason: string | null;
}

export function parseTemplateDeviationTags(
  tags: unknown,
): TemplateDeviationTags {
  const t =
    tags && typeof tags === "object" ? (tags as Record<string, unknown>) : {};
  const str = (v: unknown): string | null =>
    typeof v === "string" && v ? v : null;
  return {
    suggestedTemplate: str(t.suggestedTemplate),
    ruleId: str(t.ruleId),
    deviationReason: str(t.deviationReason),
  };
}

/**
 * Pure: build the `templateDeviation` receipt from the run's real (ground-
 * truth) template name and its tags — or `undefined` when there is nothing to
 * report (no L1 suggestion was ever attached, or the run matched it exactly
 * with no explicit deviationReason).
 */
export function buildTemplateDeviation(
  chosenTemplateName: string | null,
  tags: unknown,
): TemplateDeviation | undefined {
  if (!chosenTemplateName) return undefined;
  const { suggestedTemplate, deviationReason } =
    parseTemplateDeviationTags(tags);
  if (!suggestedTemplate) return undefined;
  if (suggestedTemplate === chosenTemplateName && !deviationReason) {
    return undefined;
  }
  return {
    chosen: chosenTemplateName,
    suggested: suggestedTemplate,
    ...(deviationReason ? { deviationReason } : {}),
  };
}

/**
 * A SINGLE writeback attempt for a terminal run. Throws on any failure (the
 * caller — `v3-reconciler.ts`'s `finalizeRun` — is responsible for retrying
 * with backoff and recording a `writeback.failed` event on exhaustion; this
 * function does not retry or swallow errors itself).
 *
 * Whitelist (mirrors the tracker's `writeback-actor.ts` gate + 02 §8 guard
 * table): `writeback-run-meta` (runId/branch backfill), `writeback-exec-state`
 * (queued|running|returned), `advance-stage` (scope=item, capped at 验收 by
 * the tracker's own F3 guard — this file never attempts to reach 交付/done).
 *
 * - `delivered`: backfill run-meta, mark execState `returned`, then advance
 *   the stage twice (实施→测试, 测试→待人工评审/验收) per the design's
 *   "阶段起点契约" (docs/sdlc-impl-f5-f10.md §5A) — `fromStage` is an
 *   EXPECTATION the tracker validates; a mismatch (item drifted, was never at
 *   实施) is a no-op on the tracker side that logs `writeback.stage-mismatch`,
 *   not an error here.
 * - `zero-delivery`: mark execState `queued` only (T-F3-06's async half —
 *   the tracker's own `writeback-exec-state` derives the `dispatch.failed`
 *   activity from `target==="queued"`, so this function doesn't send a
 *   separate signal for that).
 */
export async function onRunTerminal(outcome: WritebackOutcome): Promise<void> {
  if (outcome.kind === "zero-delivery") {
    await callTrackerTool(outcome.orgId, "writeback-exec-state", {
      workItemId: outcome.workItemId,
      target: "queued",
      reason: outcome.reason,
    });
    return;
  }

  const { workItemId, orgId, runId, branch, templateDeviation } = outcome;

  await callTrackerTool(orgId, "writeback-run-meta", {
    workItemId,
    runId,
    ...(branch ? { branch } : {}),
    // R4a.3 L2 — leave-a-trace only (§4.4 second bullet): present only when
    // the run's tags show it actually deviated from the L1 suggestion.
    ...(templateDeviation ? { templateDeviation } : {}),
  });

  await callTrackerTool(orgId, "writeback-exec-state", {
    workItemId,
    target: "returned",
    reason: "run-done",
  });

  // Two calls per the design's fixed 阶段起点契约 sequence (实施→测试→验收).
  // Each is independently idempotent/no-op-safe on the tracker side, so
  // retrying this whole function (including these two calls) on a later
  // attempt is safe.
  await callTrackerTool(orgId, "advance-stage", {
    scope: "item",
    id: workItemId,
    fromStage: "实施",
    expectedRunId: runId,
  });
  await callTrackerTool(orgId, "advance-stage", {
    scope: "item",
    id: workItemId,
    fromStage: "测试",
    expectedRunId: runId,
  });
}

// ── Retry helper (used by v3-reconciler.ts's finalizeRun hook) ─────────────

export interface BackoffAttemptResult<T> {
  ok: boolean;
  value?: T;
  error?: unknown;
  attempts: number;
}

/**
 * Retry `fn` up to `backoffMs.length + 1` total attempts, sleeping
 * `backoffMs[i]` between attempt i+1 and i+2 ("3 次退避重试" = 3 backoff
 * delays between up to 4 attempts). Never throws — callers (the reconciler)
 * decide what to do on `{ ok: false }` (write a `writeback.failed` event).
 */
export async function attemptWithBackoff<T>(
  fn: () => Promise<T>,
  backoffMs: number[] = [200, 500, 1200],
): Promise<BackoffAttemptResult<T>> {
  let lastError: unknown;
  const totalAttempts = backoffMs.length + 1;
  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      const value = await fn();
      return { ok: true, value, attempts: attempt };
    } catch (err) {
      lastError = err;
      const delay = backoffMs[attempt - 1];
      if (delay !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  return { ok: false, error: lastError, attempts: totalAttempts };
}
