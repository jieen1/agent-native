// V3 Dispatcher — bridge between reconciler and NodeRunner (DESIGN §6.2, IMPLEMENTATION §B)
//
// Sits between the V3 event-driven reconciler and the existing 7-stage NodeRunner.
// Responsibilities:
//   1. Resolve agent config from .claude/agents/*.md frontmatter
//   2. Build interpolation context from upstream dep artifacts
//   3. Render prompt via {{ }} interpolation
//   4. Map V3 4-inputs to NodeRunnerInput (adapter from D0 spike)
//   5. Classify output: string / object (ajv) / schema-violation
//   6. Truncate via max_summary_tokens
//   7. Write v3_spawns + v3_artifacts rows
//   8. Update v3_nodes status
//   9. Error class mapping: transient → recreate, schema-violation → rollback, permanent/cancelled → keep

import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { FormatName } from "ajv-formats";
import { eq, sql } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { Node, NodeRuntimeSpec } from "../../shared/types.js";
import {
  loadAgent,
  dispatchWorkerConfig,
  minimalAgentConfig,
  type AgentConfig,
} from "../agent-loader.js";
import {
  v3Runs,
  v3Nodes,
  v3Spawns,
  v3Artifacts,
  v3Events,
  spawnEvents,
} from "../db/v3-schema.js";
import { resolveRealName } from "../model-registry.js";
import {
  runClaudeCodeWorker,
  isClaudeCodeRuntime,
} from "../runtime/claude-code-worker.js";
import type { ContextCheckpoint } from "../runtime/executors/context-checkpoint.js";
import type { RuntimeExecStep } from "../runtime/executors/types.js";
import type { RuntimeExecutor } from "../runtime/executors/types.js";
import { NodeRunner } from "../runtime/node-runner.js";
import type { NodeRunnerResult } from "../runtime/node-runner.js";
import { getLocalWorkspaceDir } from "../v3-workspace-local.js";
import { WorkspaceNotReadyError } from "../v3-workspace-provision.js";
import type { V3Node, V3AgentNode } from "./dag-validator.js";
import {
  isAuditEvidenceSchema,
  validateAuditReport,
} from "./audit-evidence-validator.js";
import { renderTemplate, type ExpressionContext } from "./interpolation.js";
import {
  runAcpClaudeCodeWorker,
  isAcpClaudeCodeWorkerEnabled,
} from "./v3-acp-adapter.js";
import { getWorkspace } from "./v3-workspace.js";

/**
 * Route a CC-worker DAG-node turn. Tries the framework `acp:claude-code`
 * harness (O2 migration, off by default — see v3-acp-adapter.ts) ONLY when
 * ORCH_CC_WORKER_HARNESS=1, and falls back to the proven raw `claude` spawn
 * (server/runtime/claude-code-worker.ts) on ANY failure so a misconfigured or
 * unavailable harness (missing optional ACP packages, spawn error, etc.) can
 * never break a CC-worker node — it just silently reverts to today's path.
 *
 * `model`/`tools` now forward into the ACP path too, via
 * `metadata.claudeCode.options` (see runAcpClaudeCodeWorker) — the same
 * `_meta` channel runBrainHarnessTurn uses for the brain, so a node with an
 * explicit model/tool override no longer has to stay pinned to the raw spawn.
 */
async function runClaudeCodeNode(opts: {
  prompt: string;
  model?: string;
  tools?: string[];
  cwd?: string;
  signal?: AbortSignal;
  onStep?: (step: RuntimeExecStep) => void;
}): Promise<NodeRunnerResult> {
  if (isAcpClaudeCodeWorkerEnabled()) {
    try {
      return await runAcpClaudeCodeWorker(opts);
    } catch (err) {
      console.warn(
        `[v3-dispatcher] ACP claude-code harness failed, falling back to raw claude spawn: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return runClaudeCodeWorker(opts);
}

// ── Types ────────────────────────────────────────────────────────────────────

type NodeRow = InferSelectModel<typeof v3Nodes>;

/**
 * V3 channel input: the 4 fields a spawn receives.
 * This is the V3 channel contract — enforced at this boundary.
 */
interface V3SpawnInput {
  system_prompt: string;
  rendered_prompt: string;
  tools?: string[];
  workspace?: string;
}

/**
 * V3 channel output paths (DESIGN §6.2):
 *   1. "string"  — default, no output_schema
 *   2. "object"  — output_schema present and output validates
 *   3. "schema-violation" — output_schema present but output fails validation
 */
type V3SpawnOutput =
  | { path: "string"; value: string }
  | { path: "object"; schema: unknown; value: Record<string, unknown> }
  | { path: "schema-violation"; schema: unknown; raw: unknown; error: string };

/**
 * Error classification that drives retry policy (DESIGN §12).
 * Aligned to the four design-specified classes:
 *   transient        — API 5xx, network, rate-limit, pool exhaustion, VM failures
 *   schema-violation — output didn't match schema after self-correction
 *   permanent        — agent not found, engine not configured, render failure
 *   cancelled        — run cancelled, VM killed, parent cancelled
 */
type ErrorClass = "transient" | "schema-violation" | "permanent" | "cancelled";

// ── Constants ────────────────────────────────────────────────────────────────

/** Transient error substrings — API / network / OOM failures that can be retried. */
const TRANSIENT_INDICATORS = [
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EAI_FAIL",
  "EAI_AGAIN",
  "network",
  "timeout",
  "rate.limit",
  "rate limit",
  "too many requests",
  "429",
  "502",
  "503",
  "504",
  "OOM",
  "out of memory",
  "context deadline exceeded",
  "canceled",
  "aborted",
] as const;

/** Permanent error substrings — config errors, render failures (DESIGN §12). */
const PERMANENT_INDICATORS = [
  "agent not found",
  "engine not configured",
  "render failed",
  "prompt template",
  "invalid schema",
  "acp adapter not installed",
] as const;

/** Cancelled error substrings — abort / kill signals (DESIGN §12). */
const CANCELLED_INDICATORS = [
  "aborted",
  "canceled",
  "cancelled",
  "context canceled",
  "context deadline exceeded",
  "vm killed",
  "run cancelled",
] as const;

// ── Helpers ──────────────────────────────────────────────────────────────────

function uid(): string {
  return crypto.randomUUID();
}

/** Classify an error into a V3 error class to drive retry policy (DESIGN §12). */
function classifyErrorClass(error: unknown): ErrorClass {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const lower = message.toLowerCase();

  // Cancelled first — abort signals are terminal, not retryable
  for (const indicator of CANCELLED_INDICATORS) {
    if (lower.includes(indicator)) return "cancelled";
  }

  // Permanent — config errors, render failures fail immediately
  for (const indicator of PERMANENT_INDICATORS) {
    if (lower.includes(indicator)) return "permanent";
  }

  // Transient — API/network/rate-limit/OOM; also VM/mount errors (retryable)
  for (const indicator of TRANSIENT_INDICATORS) {
    if (lower.includes(indicator)) return "transient";
  }

  // Default: transient — retry once in case of unknown transient failure
  return "transient";
}

/** Map error class to NodeRunner onFailure policy (DESIGN §12). */
function errorClassToOnFailure(
  errorClass: ErrorClass,
): NodeRuntimeSpec["onFailure"] {
  switch (errorClass) {
    case "transient":
      return "recreate"; // boot a fresh VM on retry
    case "schema-violation":
      return "rollback"; // same VM is fine; just re-prompt
    case "permanent":
      return "keep"; // snapshot for inspection
    case "cancelled":
      return "keep"; // terminal; don't retry
  }
}

/**
 * Adapter: maps V3 4-inputs to NodeRunnerInput shape.
 * Derived from D0 spike (v3-channel-contract.spec.ts).
 */
function v3ToNodeRunnerInput(
  v3Input: V3SpawnInput,
  nodeId: string,
  nodeTitle: string,
  outputSchema?: unknown,
): { node: Node; deps: Record<string, unknown> } {
  const node: Node = {
    id: nodeId,
    type: "agent",
    title: nodeTitle,
    prompt: v3Input.rendered_prompt,
    runtime: v3Input.workspace
      ? { kind: "microvm", onFailure: "recreate" }
      : { kind: "none", onFailure: "recreate" },
    outputSchema,
  };
  return { node, deps: {} };
}

/**
 * Classify a NodeRunnerResult.output into V3 output paths.
 * If output_schema is present, validate via ajv.
 *
 * G13 note: callers must pass the extracted `assistantText` (output.text),
 * not the raw NodeRunnerResult.output object, so that schema-less nodes
 * yield bare text instead of JSON.stringify({text,...}).
 */
export function classifyOutput(
  output: unknown,
  outputSchema?: unknown,
): V3SpawnOutput {
  // No schema → string path (JSON.stringify non-strings)
  if (outputSchema === undefined) {
    return {
      path: "string",
      value: typeof output === "string" ? output : JSON.stringify(output),
    };
  }

  // Schema present — if output is a string, try to extract JSON from it first.
  // LLMs typically return JSON as text, so we need to deserialize it before
  // validating against the schema. Judgment nodes are told to answer with bare
  // JSON, but real dispatches routinely ignore that and wrap the payload in
  // prose and/or a fenced code block anyway — extractJsonFromText recovers
  // that shape deterministically instead of every occurrence needing the
  // costly attemptSchemaCorrection re-prompt below.
  let coerced: unknown = output;
  if (typeof output === "string") {
    const extracted = extractJsonFromText(output);
    if (extracted !== undefined) {
      coerced = extracted;
    }
    // else: leave `coerced` as the raw string — falls through to the
    // schema-violation "bare string" branch below.
  }

  // Schema present — must be a plain object (not array, not null)
  if (
    coerced !== null &&
    typeof coerced === "object" &&
    !Array.isArray(coerced)
  ) {
    // Validate with ajv
    try {
      const ajv = createAjv();
      const validate = ajv.compile(outputSchema as object);
      const valid = validate(coerced as Record<string, unknown>);

      if (valid) {
        // Phase H goal-audit anti-flattery gate (02-workflows.md §3.3): an
        // audit-report schema (marked `x-audit-evidence`) carries six SEMANTIC
        // rules JSON-schema cannot express (empty-word/format evidence,
        // default-P0, no metric shrink, no bragging, user-facing runtime
        // evidence, and the NO_GAPS gate). Enforce them HERE, in the same
        // validation path, so a violating report is a schema-violation (node
        // fails + retries) rather than a prompt request a model can ignore.
        if (isAuditEvidenceSchema(outputSchema)) {
          const auditResult = validateAuditReport(coerced);
          if (!auditResult.ok) {
            return {
              path: "schema-violation",
              schema: outputSchema,
              raw: coerced,
              error: `Audit report rejected by anti-flattery validator: ${auditResult.errors.join(
                "; ",
              )}`,
            };
          }
        }
        return {
          path: "object",
          schema: outputSchema,
          value: coerced as Record<string, unknown>,
        };
      }

      // Schema present but validation failed → violation
      return {
        path: "schema-violation",
        schema: outputSchema,
        raw: coerced,
        error: `Output does not match schema: ${
          validate.errors
            ?.map((e) => `${e.instancePath} ${e.message}`)
            .join("; ") ?? "validation failed"
        }`,
      };
    } catch (err: unknown) {
      // ajv compile failure (should not happen after dag validation, but be safe)
      return {
        path: "schema-violation",
        schema: outputSchema,
        raw: coerced,
        error: `Schema compile error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // A schema-typed node that returns a bare, non-JSON string is a schema
  // VIOLATION — prose must never masquerade as a structured object by being
  // silently wrapped in `{ text: <output> }`. Returning "schema-violation"
  // routes it through the ONE corrective re-prompt (attemptSchemaCorrection,
  // G14, DESIGN §6.2 step 5); if the corrected output STILL does not conform,
  // the caller fails the node with errorClass "schema-violation". An over-strict
  // schema on a genuine prose node must be fixed at the schema/node definition,
  // not masked here.
  if (typeof output === "string") {
    return {
      path: "schema-violation",
      schema: outputSchema,
      raw: output,
      error:
        `Output does not match schema: expected a JSON object but the agent ` +
        `returned a bare string (length=${output.length}).`,
    };
  }

  // Array or null when object expected → schema-violation
  return {
    path: "schema-violation",
    schema: outputSchema,
    raw: coerced,
    error: `Output does not match schema: expected object, got ${
      Array.isArray(coerced) ? "array" : typeof coerced
    }`,
  };
}

/**
 * Extract a JSON value from LLM output that may be wrapped in prose and/or
 * markdown code fences. Every `output_schema` judgment node is instructed to
 * answer with bare JSON, but models routinely explain their reasoning first
 * and/or fence the final payload anyway (task #95 production incident: a
 * real merge-review verdict, ~9.5KB, was written as markdown prose with the
 * actual JSON object in a trailing ```json fence — the schema validator saw
 * only a "bare string" and the node was marked failed even though the
 * verdict itself was correct). This is the ONE shared recovery path for
 * every schema-typed node — do not special-case it per template.
 *
 * Tried in order, returning the first that parses:
 *   1. The whole trimmed string, in case it is already bare JSON.
 *   2. The LAST ```json (or unlabeled ```) fenced block in the text — LAST,
 *      because a "preamble, then the real answer" response puts the payload
 *      at the end, and an earlier fence may just be an illustrative snippet.
 *   3. The LAST balanced top-level `{...}` object found anywhere in the text
 *      with no fences at all (string-aware brace matching, so braces inside
 *      quoted string values — e.g. a finding that quotes a code snippet —
 *      never desync the scan).
 *
 * Returns `undefined` if no strategy yields parseable JSON, so callers can
 * fall through to their existing bare-string / schema-violation handling.
 */
export function extractJsonFromText(text: string): unknown {
  const trimmed = text.trim();

  const direct = tryParseJson(trimmed);
  if (direct !== undefined) return direct;

  const fenceMatches = [
    ...trimmed.matchAll(/```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/gi),
  ];
  for (let i = fenceMatches.length - 1; i >= 0; i--) {
    const candidate = tryParseJson(fenceMatches[i][1].trim());
    if (candidate !== undefined) return candidate;
  }

  const braceObject = extractLastBalancedObject(trimmed);
  if (braceObject !== undefined) {
    const candidate = tryParseJson(braceObject);
    if (candidate !== undefined) return candidate;
  }

  return undefined;
}

/** `JSON.parse` that reports failure as `undefined` instead of throwing. */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Find the LAST balanced top-level `{...}` substring in `text`. Tracks
 * quoted-string state (with backslash-escape handling) so braces that appear
 * inside JSON string values never desync the depth count.
 */
function extractLastBalancedObject(text: string): string | undefined {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let lastCandidate: string | undefined;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          lastCandidate = text.slice(start, i + 1);
        }
      }
    }
  }

  return lastCandidate;
}

/** Create an AJV instance with all standard formats. */
function createAjv(): Ajv {
  const ajv = new Ajv({ strict: false });
  const allFormats: FormatName[] = [
    "date",
    "time",
    "date-time",
    "duration",
    "uri",
    "uri-reference",
    "uri-template",
    "url",
    "email",
    "hostname",
    "ipv4",
    "ipv6",
    "regex",
    "uuid",
    "json-pointer",
    "json-pointer-uri-fragment",
    "relative-json-pointer",
    "byte",
    "int32",
    "int64",
    "float",
    "double",
  ];
  addFormats(ajv, allFormats);
  return ajv;
}

/**
 * Truncate output to maxSummaryTokens.
 * Rough heuristic: 1 token ~ 4 chars. Enforces a character budget.
 */
function truncateToMaxTokens(
  text: string,
  maxTokens: number,
): { text: string; truncated: boolean } {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: text.slice(0, maxChars) + "\n\n... [truncated by max_summary_tokens]",
    truncated: true,
  };
}

/**
 * F7 telemetry (04 §7/§10, SDLC-051): the physically-impossible-rate guard.
 * `ORCH_MAX_TPS` (default 60) bounds output tokens/second; a spawn reporting
 * more than `elapsedSec * maxTps` output tokens, OR zero input tokens, is
 * flagged `usage_suspect` so aggregate metrics (health-telemetry, insights)
 * can exclude it instead of silently inflating on bad data (the SDLC-051
 * "10M tokens / 90s" class of bug). Pure — no I/O, unit-tested directly.
 */
function maxTps(): number {
  const raw = Number(process.env.ORCH_MAX_TPS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60;
}

export function computeUsageSuspect(opts: {
  tokensInput: number;
  tokensOutput: number;
  latencyMs: number;
}): boolean {
  if (opts.tokensInput === 0) return true;
  const elapsedSec = Math.max(opts.latencyMs, 0) / 1000;
  return opts.tokensOutput > elapsedSec * maxTps();
}

/**
 * F2b (T-F2-06): render a prior attempt's {@link ContextCheckpoint} as the
 * retry-prompt section a fresh attempt is told to read before starting —
 * "已完成产物清单" (completed artifacts so far) + "剩余任务" (remaining
 * work), matching the exact section framing spec'd in docs/sdlc-impl-f1-f4.md
 * §2A/§6.2 (T-F2-06). Callers only invoke this with a non-empty checkpoint
 * (see {@link V3Dispatcher.fetchPriorCheckpoint}), so both blocks are
 * conditional but at least one always renders.
 */
export function formatCheckpointInjection(
  checkpoint: ContextCheckpoint,
): string {
  const lines: string[] = ["── 上一次尝试的进度(重试续接,不要从零重做)──"];

  if (checkpoint.writtenFiles.length > 0) {
    lines.push("已完成产物清单:");
    for (const file of checkpoint.writtenFiles) lines.push(`- ${file}`);
  }

  if (checkpoint.remainingTasksSummary) {
    lines.push("剩余任务:");
    lines.push(checkpoint.remainingTasksSummary);
  }

  return lines.join("\n");
}

// ── V3Dispatcher ─────────────────────────────────────────────────────────────

export class V3Dispatcher {
  private readonly db: PostgresJsDatabase;
  private readonly runner: NodeRunner;

  constructor(db: PostgresJsDatabase, executor: RuntimeExecutor) {
    this.db = db;
    this.runner = new NodeRunner({ executor });
  }

  /**
   * Spawn an agent node (DESIGN §6.2, IMPLEMENTATION §B).
   *
   * Steps:
   *  1. Load DAG + dagNode; resolve agent name from dagNode.agent (G8)
   *  2. Resolve agent config via loadAgent(dagNode.agent)
   *  3. Build interpolation context from v3_nodes deps → their v3_artifacts
   *  4. Render prompt from dagNode.prompt (G7) — NOT from agentConfig.systemPrompt
   *  5. Create V3 spawn input (4-field channel contract)
   *  6. Mount workspace VM via v3-workspace.ts exports if dagNode.workspace set (G34)
   *  7. Thread dagNode.retry + dagNode.timeout_seconds into NodeRunner node (G27)
   *  8. Call NodeRunner with the run's abort signal + timeout enforcer (G27)
   *  9. Extract assistant text (output.text) before classifyOutput (G13)
   *  10. classifyOutput; on schema-violation: ONE corrective re-prompt (G14)
   *  11. Truncate via max_summary_tokens with per-node override (G32)
   *  12. Write v3_spawns + v3_artifacts (plumb full_content_ref) (G33)
   *  13. Update v3_nodes status
   */
  async spawn(
    nodeRow: NodeRow,
    runId: string,
    runSignal?: AbortSignal,
  ): Promise<string> {
    const spawnId = uid();
    const startedAt = new Date();

    // ── Step 1: Load DAG node (G8 — must happen before resolveAgentConfig) ─
    const dag = await this.loadDagForRun(runId);
    const dagNode = this.findDagNode(dag, nodeRow.nodeIdInDag);

    // Cast to agent node for field access; fall back to safe defaults.
    // V3AgentNode already has workspace?, engine_override?, model_override?,
    // retry?, timeout_seconds?, max_summary_tokens? per dag-validator.ts.
    const agentDagNode =
      dagNode?.type === "agent" ? (dagNode as V3AgentNode) : undefined;
    const dagNodeAgentName = agentDagNode?.agent;
    const dagNodePrompt = agentDagNode?.prompt;
    const outputSchema = agentDagNode?.output_schema;

    // ── Step 2: Resolve agent config — use dagNode.agent field (G8) ───────
    const agentConfig = await this.resolveAgentConfig(
      nodeRow,
      dagNodeAgentName,
    );

    // ── Step 3: Build interpolation context ───────────────────────────────
    const context = await this.buildInterpolationContext(runId, nodeRow);

    // ── Step 4: Render prompt from dagNode.prompt (G7) ────────────────────
    // dagNode.prompt is the template string authored by the DAG author with
    // {{ }} interpolations. system_prompt stays static / verbatim (channel
    // input 1). NEVER render system_prompt as the user prompt.
    const renderedBasePrompt = dagNodePrompt
      ? renderTemplate(dagNodePrompt, context)
      : "(no prompt defined)";

    // ── Step 4a: F2b retry checkpoint injection (T-F2-06) ──────────────────
    // C3 ("截断重试=携带已完成工作,禁止从零重跑"): a RETRY attempt (this node
    // already has >=1 prior v3_spawns row) carries forward the immediately-
    // prior attempt's context_checkpoint — written-files list + remaining-
    // work summary — appended AFTER interpolation, never re-run through
    // renderTemplate: the checkpoint is untrusted prior-LLM-output text that
    // could itself contain a literal `{{...}}` and blow up interpolation. A
    // node's FIRST attempt has no prior spawn row, so fetchPriorCheckpoint
    // returns null and the prompt is unchanged. A prior attempt that never
    // got far enough to checkpoint anything (null/empty) also yields null —
    // no fabricated placeholder section.
    const priorCheckpoint = await this.fetchPriorCheckpoint(nodeRow);
    const renderedPrompt = priorCheckpoint
      ? `${renderedBasePrompt}\n\n${formatCheckpointInjection(priorCheckpoint)}`
      : renderedBasePrompt;

    // ── Step 4b: Resolve the node's workspace ref (BUG 1 fix) ──────────────
    // The DAG author writes `workspace: "{{inputs.workspaceId}}"` (a channel
    // template), so the RAW field is NOT a workspace id — it must be rendered
    // through the SAME interpolation engine + context as the prompt before it
    // is handed to getWorkspace / getLocalWorkspaceDir. Without this, resolving
    // the literal "{{inputs.workspaceId}}" returns null → no hostDir → the node
    // runs in a throwaway /tmp/an-none-… dir instead of the shared checkout, so
    // its edits are discarded and nothing is committed.
    const rawWorkspaceRef = agentDagNode?.workspace;
    let resolvedWorkspaceRef: string | undefined;
    if (rawWorkspaceRef) {
      try {
        resolvedWorkspaceRef = renderTemplate(rawWorkspaceRef, context).trim();
      } catch {
        // Interpolation failed (e.g. path not present yet) — fall back to the
        // raw ref so behaviour is no worse than before the fix.
        resolvedWorkspaceRef = rawWorkspaceRef;
      }
      if (!resolvedWorkspaceRef) resolvedWorkspaceRef = undefined;
    }

    // ── Step 5: Create V3 spawn input (4-field channel contract) ──────────
    // system_prompt = verbatim from agent.md (channel input 1).
    // rendered_prompt = interpolated dagNode.prompt, plus the F2b retry
    // checkpoint section on a retry attempt (channel input 2).
    const v3Input: V3SpawnInput = {
      system_prompt: agentConfig.systemPrompt,
      rendered_prompt: renderedPrompt,
      tools: agentConfig.tools.length > 0 ? agentConfig.tools : undefined,
      workspace: agentConfig.runtime === "microvm" ? "/work" : undefined,
    };

    // ── Step 6: Mount workspace VM (G34) ──────────────────────────────────
    // If dagNode.workspace is set, call the EXISTING v3-workspace.ts exports
    // to obtain the workspace's vmName. Do NOT boot a disposable VM here.
    let resolvedWorkspaceId: string | null = null;
    if (resolvedWorkspaceRef) {
      const ws = await getWorkspace(resolvedWorkspaceRef).catch(() => null);
      if (ws) {
        // F1 readiness gate (02-workflows.md §7, T-F1-09): never spawn/dispatch
        // a node on a workspace that has not passed the full W1→W2→W3 readiness
        // sequence. `readyAt` is set only once that sequence passes; a null
        // value means provisioning/failed/reset-unready — reject BEFORE any
        // spawn row is opened (Step 8a never runs) and emit `workspace.not_ready`
        // (kind=infra) so the run's event stream records WHY the node didn't
        // advance, without counting it as an agent failure.
        if (!ws.readyAt) {
          await this.writeEvent(runId, "workspace.not_ready", {
            nodeId: nodeRow.nodeIdInDag,
            workspaceId: ws.id,
            state: ws.state,
            errorClass: "infra",
          });
          throw new WorkspaceNotReadyError(
            "W1",
            `workspace '${ws.id}' has no ready_at (state=${ws.state}) — dispatch rejected`,
          );
        }
        resolvedWorkspaceId = ws.id;
        // Override the workspace path — the long-lived VM is already at /work.
        v3Input.workspace = "/work";
      }
      // else: workspace lookup failed — proceed without workspace mount (the
      // node still runs but without the workspace context), unchanged legacy
      // behaviour for a dangling/unresolvable workspace ref.
    }

    // ── Step 7: Build NodeRunner node with retry / timeout from dag (G27) ─
    const { node: runnerNode } = v3ToNodeRunnerInput(
      v3Input,
      nodeRow.id,
      nodeRow.nodeIdInDag,
      outputSchema,
    );

    // Apply engine/model overrides: dagNode overrides > agent config.
    const engineOverride = agentDagNode?.engine_override;
    const modelOverride = agentDagNode?.model_override;
    if (engineOverride) {
      runnerNode.engine = engineOverride;
    } else if (agentConfig.engine) {
      runnerNode.engine = agentConfig.engine;
    }
    if (modelOverride) {
      runnerNode.model = modelOverride;
      // Task #89: also carry the RAW explicit override on its own field.
      // `runnerNode.model` above is already flattened (override ?? agent-def
      // static default) for every existing RuntimeExecutor that reads `model`
      // directly (RemoteApiExecutor, ClaudeCodeExecutor) — leave that
      // unchanged. `modelOverride` lets RoutingRuntimeExecutor/VllmExecutor
      // tell a deliberate per-node choice apart from the agent-def default,
      // so it can still win even when the node routes to a runtime_configs
      // row whose own `model` would otherwise apply.
      runnerNode.modelOverride = modelOverride;
    } else if (agentConfig.model) {
      runnerNode.model = agentConfig.model;
    }

    // Thread dagNode.retry into the NodeRunner node (G27).
    const dagRetry = agentDagNode?.retry;
    if (dagRetry) {
      runnerNode.retry = {
        max: dagRetry.max,
        backoffMs: dagRetry.initial_ms ?? 1000,
      };
    }

    // Thread dagNode.timeout_seconds → timeoutMs (G27).
    const timeoutSeconds = agentDagNode?.timeout_seconds;
    if (typeof timeoutSeconds === "number" && timeoutSeconds > 0) {
      runnerNode.timeoutMs = timeoutSeconds * 1000;
    }

    // ── Step 8: Run — use the run's abort signal; enforce timeout (G27) ───
    // Build a composed signal: abort if the run's signal fires OR if the
    // per-node timeout elapses (whichever comes first).
    const timeoutMs = runnerNode.timeoutMs;
    const effectiveSignal = this.buildAbortSignal(runSignal, timeoutMs);

    // Claude Code (subscription) agents run via the container's OWN managed
    // login (DESIGN §7.3 `acp:claude-code`) — `claude -p` host-native, no VM,
    // no host-credential sharing. Every other agent runs on the engine executor
    // (vLLM / hosted API) through the 7-stage NodeRunner.
    // Workspace (non-microVM git checkout): resolve the shared local dir so the
    // worker runs IN the project the workflow targets (DESIGN §10.6 / orca).
    const localWorkspaceDir = resolvedWorkspaceRef
      ? ((await getLocalWorkspaceDir(resolvedWorkspaceRef)) ?? undefined)
      : undefined;
    // MICROVM OPT-IN (msb bridge): when ORCH_FORCE_MICROVM=1 AND the host msb
    // bridge is configured (ORCH_MSB_BRIDGE_URL), an engine (vLLM/API) node runs
    // its tool side-effects inside a REAL libkrun microVM instead of host-native.
    // The agent loop still runs in THIS container (so spawn_events stream live);
    // only the bash/read/write tools + the clone/commit/push delivery cross the
    // bridge into the VM. We hand the runtime the workspace's repo/branch so the
    // NodeRunner clones the project in-VM and pushes the run branch on success.
    const forceMicrovm =
      process.env.ORCH_FORCE_MICROVM === "1" &&
      !!process.env.ORCH_MSB_BRIDGE_URL &&
      process.env.ORCH_MSB_BRIDGE_URL.trim() !== "";
    // A node is microvm-eligible when it would otherwise run as an engine node
    // bound to a workspace: either its agent declares runtime:microvm, OR the
    // DAG node assigned it a workspace (which made v3ToNodeRunnerInput set the
    // runner runtime kind to "microvm"). Claude Code is always excluded — it
    // runs via the container's managed login, never in a VM.
    const microvmEligible =
      forceMicrovm &&
      !isClaudeCodeRuntime(agentConfig.runtime) &&
      (agentConfig.runtime === "microvm" ||
        runnerNode.runtime?.kind === "microvm" ||
        !!resolvedWorkspaceRef);
    if (microvmEligible && runnerNode.runtime) {
      // Route to MicrosandboxRuntime over the bridge. Pull the repo/branch from
      // the resolved workspace row so the in-VM clone + delivery target the real
      // project (NOT the host checkout dir — the VM clones its own copy).
      let wsRepo: string | undefined;
      let wsBranch: string | undefined;
      let wsBase: string | undefined;
      if (resolvedWorkspaceRef) {
        try {
          const ws = await getWorkspace(resolvedWorkspaceRef);
          wsRepo = ws.repoUrl ?? undefined;
          wsBranch = ws.branch ?? undefined;
          wsBase =
            (ws.tags && (ws.tags as Record<string, string>).base_ref) ||
            undefined;
        } catch {
          // fall through — without a repo the node still runs, just no delivery.
        }
      }
      runnerNode.runtime.kind = "microvm";
      runnerNode.runtime.hostDir = undefined;
      if (wsRepo) runnerNode.runtime.gitRemote = wsRepo;
      if (wsBranch) runnerNode.runtime.branch = wsBranch;
      if (wsBase) runnerNode.runtime.baseRef = wsBase;
      // Pin the prebaked worker image (the runtime default is the same, but be
      // explicit so the spec records exactly what booted).
      if (!runnerNode.runtime.image) {
        runnerNode.runtime.image =
          process.env.ORCH_WORKER_IMAGE || "localhost:5000/an-worker:latest";
      }
      // eslint-disable-next-line no-console
      console.log(
        `[microvm] node=${nodeRow.nodeIdInDag} routed to MicrosandboxRuntime ` +
          `via msb bridge (image=${runnerNode.runtime.image}, repo=${wsRepo ?? "(none)"}, branch=${wsBranch ?? "(none)"})`,
      );
    } else if (localWorkspaceDir && runnerNode.runtime) {
      // DEFAULT (no msb bridge / not forced): a local git checkout → run
      // host-native IN it (NoneRuntime symlinks /work → hostDir). The DAG
      // `workspace` field otherwise routes the node to MicrosandboxRuntime
      // (wsl/msb), which isn't available in a plain Docker deployment.
      runnerNode.runtime.kind = "none";
      runnerNode.runtime.hostDir = localWorkspaceDir;
    }
    // ── Step 8a: Open the spawn row NOW (status running) + bind it to the node
    // BEFORE the worker starts, so a RUNNING node has a live row + a growing
    // transcript the Node Inspector can poll. The terminal writeSpawnRecord below
    // UPDATEs this same row to done/failed (DESIGN §8.5). Best-effort.
    await this.openRunningSpawn({
      spawnId,
      nodeRow,
      agentConfig,
      renderedPrompt,
      startedAt,
      workspaceId: resolvedWorkspaceId,
    });

    // LIVE step sink: append each intermediate step to `spawn_events` AS IT
    // ARRIVES (idempotent on (spawn_id, seq)). Fire-and-forget so the worker is
    // never blocked on a DB round-trip; a logging error never fails the node.
    const onStep = (step: RuntimeExecStep): void => {
      void this.appendSpawnEvent(spawnId, nodeRow, step);
    };

    const runnerResult = isClaudeCodeRuntime(agentConfig.runtime)
      ? await runClaudeCodeNode({
          prompt: renderedPrompt,
          model: runnerNode.model,
          tools: agentConfig.tools.length > 0 ? agentConfig.tools : undefined,
          cwd: localWorkspaceDir,
          signal: effectiveSignal,
          onStep,
        })
      : await this.runner.run(
          {
            node: runnerNode,
            deps: context.deps,
            spawnId,
            ownerEmail: nodeRow.ownerEmail,
            orgId: nodeRow.orgId,
            onStep,
          },
          effectiveSignal,
        );

    const latencyMs = Date.now() - startedAt.getTime();

    // ── Step 8b: Backstop the INTERMEDIATE transcript (spawn_events) ───────
    // The live `onStep` sink already streamed steps for a running node. This is
    // a best-effort BACKSTOP: re-insert the full ordered list so a node whose
    // live appends were dropped (sink error / fire-and-forget race) still ends
    // up with a complete transcript. Idempotent on (spawn_id, seq) — already-
    // written rows are no-ops. A logging failure must NEVER fail the node.
    await this.writeSpawnEvents(spawnId, nodeRow, runnerResult.steps);
    const spawnEventCount = runnerResult.steps?.length ?? 0;

    // ── Step 9: Extract assistant text before classifyOutput (G13) ────────
    // runnerResult.output is { text, toolCallCount, model } for schema-less
    // nodes. We need the bare text string, not a JSON.stringify of the object.
    const rawOutput = runnerResult.output;
    const assistantText: unknown =
      rawOutput !== null &&
      typeof rawOutput === "object" &&
      "text" in (rawOutput as Record<string, unknown>)
        ? (rawOutput as Record<string, unknown>).text
        : rawOutput;

    // ── Step 10: Classify output; on schema-violation: ONE re-prompt (G14) ─
    let classifiedOutput = classifyOutput(assistantText, outputSchema);

    if (classifiedOutput.path === "schema-violation") {
      // DESIGN §6.2 step 5: ONE internal self-correction attempt.
      const correctedOutput = await this.attemptSchemaCorrection(
        nodeRow,
        runId,
        agentConfig,
        renderedPrompt,
        assistantText,
        outputSchema,
        classifiedOutput.error,
        effectiveSignal,
      );

      if (correctedOutput !== null) {
        // Re-classify with the corrected output.
        classifiedOutput = classifyOutput(correctedOutput, outputSchema);
      }

      // If still a violation after the correction attempt, fail the node.
      if (classifiedOutput.path === "schema-violation") {
        const usage = await this.resolveSpawnUsage(
          runnerResult,
          latencyMs,
          agentConfig,
          nodeRow,
        );
        await this.writeSpawnRecord({
          spawnId,
          nodeRow,
          agentConfig,
          renderedPrompt,
          startedAt,
          completedAt: new Date(),
          status: "failed",
          outputKind: "schema-violation",
          outputArtifactId: null,
          workspaceId: resolvedWorkspaceId,
          tokensInput: usage.tokensInput,
          tokensOutput: usage.tokensOutput,
          latencyMs,
          error: classifiedOutput.error,
          errorClass: "schema-violation",
          modelRealName: usage.modelRealName,
          usageSuspect: usage.usageSuspect,
          vmName: runnerResult.vmName,
          spawnEventCount,
        });

        await this.failNode(
          nodeRow,
          classifiedOutput.error,
          "schema-violation",
        );

        return spawnId;
      }
    }

    // ── Step 11: Truncate via max_summary_tokens (G32) ────────────────────
    // Per-node override > agent.md value > default 2000 (DESIGN §11 layer 3).
    const maxSummaryTokens =
      agentDagNode?.max_summary_tokens ?? agentConfig.maxSummaryTokens ?? 2000;

    let truncated = false;
    let textContent: string | null = null;
    let objectContent: Record<string, unknown> | null = null;
    // G33: full_content_ref for large secondary outputs.
    let fullContentRef: string | null = null;

    switch (classifiedOutput.path) {
      case "string": {
        const result = truncateToMaxTokens(
          classifiedOutput.value,
          maxSummaryTokens,
        );
        textContent = result.text;
        truncated = result.truncated;
        if (truncated) {
          // Store the full text as a ref when it exceeds the token cap.
          fullContentRef = await this.writeFullContentRef(
            spawnId,
            classifiedOutput.value,
            nodeRow,
          );
        }
        break;
      }
      case "object": {
        objectContent = classifiedOutput.value;
        // Also store a text summary for quick reads.
        const serialized = JSON.stringify(classifiedOutput.value);
        const result = truncateToMaxTokens(serialized, maxSummaryTokens);
        textContent = result.text;
        truncated = result.truncated;
        if (truncated) {
          fullContentRef = await this.writeFullContentRef(
            spawnId,
            serialized,
            nodeRow,
          );
        }
        break;
      }
      // "schema-violation" was already handled above and returned early.
    }

    // Emit summary_truncated event when truncating (G32).
    if (truncated) {
      await this.writeEvent(runId, "summary_truncated", {
        nodeId: nodeRow.id,
        nodeIdInDag: nodeRow.nodeIdInDag,
        spawnId,
        maxSummaryTokens,
        fullContentRef,
      });
    }

    // ── Step 12: Write v3_spawns + v3_artifacts (G33) ────────────────────
    const artifactId = uid();
    const byteSize = textContent
      ? new TextEncoder().encode(textContent).length
      : 0;

    await this.db.insert(v3Artifacts).values({
      id: artifactId,
      spawnId,
      kind: classifiedOutput.path,
      textContent,
      objectContent,
      fullContentRef,
      byteSize,
      truncated: truncated ? 1 : 0,
      createdAt: new Date(),
      ownerEmail: nodeRow.ownerEmail,
      orgId: nodeRow.orgId,
    });

    const usage = await this.resolveSpawnUsage(
      runnerResult,
      latencyMs,
      agentConfig,
      nodeRow,
    );
    await this.writeSpawnRecord({
      spawnId,
      nodeRow,
      agentConfig,
      renderedPrompt,
      startedAt,
      completedAt: new Date(),
      status: "done",
      outputKind: classifiedOutput.path,
      outputArtifactId: artifactId,
      workspaceId: resolvedWorkspaceId,
      tokensInput: usage.tokensInput,
      tokensOutput: usage.tokensOutput,
      latencyMs,
      error: null,
      errorClass: null,
      modelRealName: usage.modelRealName,
      usageSuspect: usage.usageSuspect,
      vmName: runnerResult.vmName,
      spawnEventCount,
    });

    // ── Step 13: Update v3_nodes status ───────────────────────────────────
    await this.db
      .update(v3Nodes)
      .set({
        status: "done",
        outputArtifactId: artifactId,
        completedAt: new Date(),
      })
      .where(eq(v3Nodes.id, nodeRow.id));

    return spawnId;
  }

  /**
   * Resolve agent config from the DAG node's `agent` field (G8).
   * Falls back to nodeRow.nodeIdInDag if dagNodeAgentName is absent.
   */
  private async resolveAgentConfig(
    nodeRow: NodeRow,
    dagNodeAgentName?: string,
  ): Promise<AgentConfig> {
    // G8: use dagNode.agent (the node field), not nodeRow.nodeIdInDag.
    const agentName = dagNodeAgentName ?? nodeRow.nodeIdInDag;
    try {
      const config = await loadAgent(agentName);
      // F4 (design 02 §5.4): the `kind: "brain"` agent-def row exists ONLY to
      // carry the orchestrator brain's per-phase capability profile — it is
      // not a worker and must never execute as a DAG node. list-agent-defs
      // already hides it from the WorkflowEditor picker; this is the
      // mechanism-level backstop for hand-authored DAGs. dispatchWorkerConfig
      // collapses a brain row to the same minimal prompt-only config as the
      // agent-not-found path (below); the warn is observability only.
      if (config.kind === "brain") {
        console.warn(
          `[v3-dispatcher] agent '${agentName}' is the brain capability-profile row (kind="brain"), not a DAG worker — using minimal config instead`,
        );
      }
      return dispatchWorkerConfig(config, agentName);
    } catch {
      // Agent file not found — fall through to the minimal config so the spawn
      // can still proceed with the rendered prompt alone.
    }
    return minimalAgentConfig(agentName);
  }

  /**
   * Build a composed AbortSignal (G27):
   * - aborts if the parent run signal fires, OR
   * - aborts after timeoutMs if provided.
   */
  private buildAbortSignal(
    runSignal: AbortSignal | undefined,
    timeoutMs: number | undefined,
  ): AbortSignal {
    const combined = new AbortController();

    const abort = (reason?: unknown) => {
      if (!combined.signal.aborted) combined.abort(reason);
    };

    if (runSignal) {
      if (runSignal.aborted) {
        abort(runSignal.reason);
      } else {
        runSignal.addEventListener("abort", () => abort(runSignal.reason), {
          once: true,
        });
      }
    }

    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      const timer = setTimeout(
        () => abort(new Error(`node timeout after ${timeoutMs}ms`)),
        timeoutMs,
      );
      // Clean up the timer if the signal fires first.
      combined.signal.addEventListener("abort", () => clearTimeout(timer), {
        once: true,
      });
    }

    return combined.signal;
  }

  /**
   * ONE corrective re-prompt on schema violation (G14, DESIGN §6.2 step 5).
   * Feeds the AJV error messages back to the model as a new user turn.
   * Returns the corrected raw output, or null if the correction also fails.
   */
  private async attemptSchemaCorrection(
    nodeRow: NodeRow,
    _runId: string,
    agentConfig: AgentConfig,
    _originalRenderedPrompt: string,
    originalOutput: unknown,
    _outputSchema: unknown,
    violationError: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    // Build a corrective prompt that shows what was wrong.
    const correctionPrompt =
      `Your previous response did not match the required JSON schema.\n\n` +
      `Schema violations:\n${violationError}\n\n` +
      `Your previous response:\n${
        typeof originalOutput === "string"
          ? originalOutput
          : JSON.stringify(originalOutput)
      }\n\n` +
      `Please respond ONLY with valid JSON that matches the required schema. ` +
      `Do not include any other text.`;

    try {
      // Build a minimal NodeRunner call for the corrective re-prompt.
      const correctionNode: Node = {
        id: `${nodeRow.id}-correction`,
        type: "agent",
        title: "schema-correction",
        prompt: correctionPrompt,
        runtime: { kind: "none", onFailure: "keep" },
      };

      if (agentConfig.engine) correctionNode.engine = agentConfig.engine;
      if (agentConfig.model) correctionNode.model = agentConfig.model;

      const correctionResult = await this.runner.run(
        {
          node: correctionNode,
          deps: {},
          ownerEmail: nodeRow.ownerEmail,
          orgId: nodeRow.orgId,
        },
        signal,
      );

      // Extract text from the correction result.
      const rawCorrected = correctionResult.output;
      const correctedText: unknown =
        rawCorrected !== null &&
        typeof rawCorrected === "object" &&
        "text" in (rawCorrected as Record<string, unknown>)
          ? (rawCorrected as Record<string, unknown>).text
          : rawCorrected;

      // Extract JSON if the output is a string — same shared strategy as the
      // first-pass classifyOutput (bare / fenced / trailing-object), since a
      // corrective re-prompt can just as easily come back prose-wrapped.
      if (typeof correctedText === "string") {
        const extracted = extractJsonFromText(correctedText);
        return extracted !== undefined ? extracted : correctedText;
      }
      return correctedText;
    } catch {
      // Correction attempt itself failed — return null so the caller fails the node.
      return null;
    }
  }

  /**
   * Write full content as a secondary v3_artifacts row in SQL and return a
   * `sql:<artifactId>` ref pointer (G33). Replaces the previous /tmp approach
   * which was lost on container restart and not shared across replicas.
   */
  private async writeFullContentRef(
    spawnId: string,
    content: string,
    nodeRow: NodeRow,
  ): Promise<string | null> {
    try {
      const artifactId = uid();
      await this.db.insert(v3Artifacts).values({
        id: artifactId,
        spawnId,
        kind: "full_content",
        textContent: content,
        objectContent: null,
        fullContentRef: null,
        byteSize: new TextEncoder().encode(content).length,
        truncated: 0,
        ownerEmail: nodeRow.ownerEmail,
        orgId: nodeRow.orgId,
      });
      return `sql:${artifactId}`;
    } catch {
      // Full content ref is best-effort; never block the spawn write.
      return null;
    }
  }

  /**
   * Write a v3_event with auto-incrementing seq_num.
   */
  private async writeEvent(
    runId: string,
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const maxResult = await this.db
      .select({
        nextSeq: sql<number>`COALESCE(MAX(${v3Events.seqNum}), 0) + 1`,
      })
      .from(v3Events)
      .where(eq(v3Events.runId, runId));

    const nextSeq = maxResult[0]?.nextSeq ?? 1;

    await this.db.insert(v3Events).values({
      id: uid(),
      runId,
      spawnId: null,
      kind,
      payload,
      seqNum: nextSeq,
      ts: new Date(),
      ownerEmail: "local@localhost",
      orgId: null,
    });
  }

  /**
   * Build interpolation context for a node (DESIGN §5.1, §6.4).
   *
   * 1. Read node from v3_nodes to get nodeIdInDag
   * 2. Load DAG from v3_runs to find deps for this nodeIdInDag
   * 3. For each dep, find the dep node's output_artifact_id → read v3_artifacts
   * 4. Map artifact content to deps[depId].output
   * 5. Include v3_runs[runId].inputs as top-level inputs
   * 6. Return ExpressionContext shape
   */
  async buildInterpolationContext(
    runId: string,
    nodeRow: NodeRow,
  ): Promise<ExpressionContext> {
    // Read run inputs
    const [run] = await this.db
      .select()
      .from(v3Runs)
      .where(eq(v3Runs.id, runId));

    if (!run) {
      return { inputs: {}, deps: {} };
    }

    // Load DAG to resolve dep edges for this node
    const dag = await this.loadDagForRun(runId);
    const depIds = this.getNodeDeps(nodeRow, dag);

    // Read all nodes for this run to find dep artifact ids
    const allNodes = await this.db
      .select()
      .from(v3Nodes)
      .where(eq(v3Nodes.runId, runId));

    const deps: ExpressionContext["deps"] = {};

    for (const depId of depIds) {
      // Find the latest resolved node for this dep id
      const depNode = allNodes
        .filter(
          (n) =>
            n.nodeIdInDag === depId &&
            (n.status === "done" || n.status === "skipped"),
        )
        .sort((a, b) => b.iteration - a.iteration)[0];

      if (!depNode || !depNode.outputArtifactId) {
        deps[depId] = { output: undefined };
        continue;
      }

      // Read artifact
      const [artifact] = await this.db
        .select()
        .from(v3Artifacts)
        .where(eq(v3Artifacts.id, depNode.outputArtifactId));

      if (!artifact) {
        deps[depId] = { output: undefined };
        continue;
      }

      // Resolve artifact content: prefer object_content, fall back to text_content
      const output = artifact.objectContent ?? artifact.textContent;
      deps[depId] = { output };
    }

    // Cast run.inputs to Record<string, unknown>
    const inputs = (run.inputs ?? {}) as Record<string, unknown>;

    return {
      inputs,
      deps,
      iteration: nodeRow.iteration > 0 ? nodeRow.iteration : undefined,
    };
  }

  /**
   * F2b (T-F2-06): fetch the immediately-prior attempt's `context_checkpoint`
   * for this node, for retry-prompt injection in {@link spawn} Step 4a. A
   * node's spawn history is durable (every attempt — in-process retry or
   * reconcile-conduction-triggered redispatch after a restart — inserts a NEW
   * `v3_spawns` row bound by `node_id`; see the durable-attempt-counter note
   * on `reconcileSpawnConduction` in v3-reconciler.ts), so "zero rows" IS the
   * first-attempt signal. Returns null on a first attempt, or when the prior
   * attempt's checkpoint was never computed or carries nothing usable (empty
   * writtenFiles AND no remainingTasksSummary) — callers must inject nothing
   * in either case rather than fabricate a placeholder section.
   */
  private async fetchPriorCheckpoint(
    nodeRow: NodeRow,
  ): Promise<ContextCheckpoint | null> {
    const priorSpawns = await this.db
      .select({
        startedAt: v3Spawns.startedAt,
        contextCheckpoint: v3Spawns.contextCheckpoint,
      })
      .from(v3Spawns)
      .where(eq(v3Spawns.nodeId, nodeRow.id));

    if (priorSpawns.length === 0) return null;

    const [latest] = [...priorSpawns].sort((a, b) => {
      const at = a.startedAt ? new Date(a.startedAt).getTime() : 0;
      const bt = b.startedAt ? new Date(b.startedAt).getTime() : 0;
      return bt - at;
    });

    const checkpoint = (latest?.contextCheckpoint ??
      null) as ContextCheckpoint | null;
    if (!checkpoint) return null;
    const hasWrittenFiles =
      Array.isArray(checkpoint.writtenFiles) &&
      checkpoint.writtenFiles.length > 0;
    if (!hasWrittenFiles && !checkpoint.remainingTasksSummary) return null;

    return checkpoint;
  }

  // ── Private: DB writes ───────────────────────────────────────────────────

  /**
   * Open the spawn row at START (status `running`) and bind it to the node's
   * `current_spawn_id` BEFORE the worker begins (DESIGN §8.5 — live capture).
   * Without this, no `v3_spawns` row exists while the node runs, so the Node
   * Inspector cannot resolve a spawnId to poll its growing transcript. The
   * terminal {@link writeSpawnRecord} UPDATEs this same row. Idempotent via
   * `onConflictDoNothing` on the primary key; best-effort (never fails the node).
   */
  private async openRunningSpawn(opts: {
    spawnId: string;
    nodeRow: NodeRow;
    agentConfig: AgentConfig;
    renderedPrompt: string;
    startedAt: Date;
    workspaceId: string | null;
  }): Promise<void> {
    try {
      await this.db
        .insert(v3Spawns)
        .values({
          id: opts.spawnId,
          nodeId: opts.nodeRow.id,
          attempt: 1,
          agentName: opts.agentConfig.name,
          engineRef: opts.agentConfig.engine || null,
          modelRef: opts.agentConfig.model || null,
          runtime: opts.agentConfig.runtime,
          workspaceId: opts.workspaceId,
          renderedPrompt: opts.renderedPrompt,
          status: "running",
          startedAt: opts.startedAt,
          ownerEmail: opts.nodeRow.ownerEmail,
          orgId: opts.nodeRow.orgId,
        })
        .onConflictDoNothing({ target: v3Spawns.id });
      // Bind the node to this spawn so the Node Inspector can poll it live.
      await this.db
        .update(v3Nodes)
        .set({ currentSpawnId: opts.spawnId })
        .where(eq(v3Nodes.id, opts.nodeRow.id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[spawn-events] openRunningSpawn ${opts.spawnId}: ${msg}`);
    }
  }

  /**
   * Append ONE intermediate step to `spawn_events` AS IT ARRIVES from the live
   * worker sink (DESIGN §8.5). Idempotent on (spawn_id, seq) so a backstop
   * re-write is a no-op. Best-effort — a logging error never fails the node.
   */
  private async appendSpawnEvent(
    spawnId: string,
    nodeRow: NodeRow,
    step: RuntimeExecStep,
  ): Promise<void> {
    try {
      await this.db
        .insert(spawnEvents)
        .values({
          id: uid(),
          spawnId,
          seq: step.seq,
          type: step.type,
          name: step.name ?? null,
          input: step.input !== undefined ? (step.input as unknown) : null,
          result: step.result !== undefined ? (step.result as unknown) : null,
          text: step.text ?? null,
          createdAt: new Date(),
          ownerEmail: nodeRow.ownerEmail,
          orgId: nodeRow.orgId,
        })
        .onConflictDoNothing({
          target: [spawnEvents.spawnId, spawnEvents.seq],
        });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[spawn-events] append ${spawnId}#${step.seq}: ${msg}`);
    }
  }

  /**
   * Persist a spawn's INTERMEDIATE transcript as `spawn_events` rows (DESIGN
   * §8.5 — the Node Inspector execution timeline). Each step (reasoning text /
   * tool_use / tool_result) becomes one row keyed by (spawnId, seq). Used as a
   * BACKSTOP after the live `onStep` sink — the per-row insert is
   * `onConflictDoNothing` so already-streamed rows are no-ops. Best-effort —
   * wrapped in try/catch so a re-run never fails the node on a logging error. A
   * spawn that did no tool calls simply writes no rows.
   */
  private async writeSpawnEvents(
    spawnId: string,
    nodeRow: NodeRow,
    steps: RuntimeExecStep[] | undefined,
  ): Promise<void> {
    if (!steps || steps.length === 0) return;
    try {
      const rows = steps.map((s) => ({
        id: uid(),
        spawnId,
        seq: s.seq,
        type: s.type,
        name: s.name ?? null,
        input: s.input !== undefined ? (s.input as unknown) : null,
        result: s.result !== undefined ? (s.result as unknown) : null,
        text: s.text ?? null,
        createdAt: new Date(),
        ownerEmail: nodeRow.ownerEmail,
        orgId: nodeRow.orgId,
      }));
      await this.db
        .insert(spawnEvents)
        .values(rows)
        .onConflictDoNothing({
          target: [spawnEvents.spawnId, spawnEvents.seq],
        });
    } catch (err) {
      // Never fail the node on a logging error (DESIGN §8.5).
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[spawn-events] failed to persist for ${spawnId}: ${msg}`);
    }
  }

  /**
   * F7 telemetry (04 §7/§10/§13, SDLC-051/054): derive the real tokens_input/
   * tokens_output + model_real_name + usage_suspect values for a completed
   * spawn from the raw `runnerResult`. `runnerResult.tokensInput`/
   * `tokensOutput` are OPTIONAL (see `RuntimeExecResult`/`NodeRunnerResult`) —
   * an executor that has not been migrated to report the split (e.g. the
   * claude-code-worker path) simply omits them, and a missing tokensInput
   * defaults to 0, which the physically-impossible-rate guard below already
   * treats as suspect — so an un-migrated executor's rows are correctly
   * flagged rather than silently trusted.
   */
  private async resolveSpawnUsage(
    runnerResult: NodeRunnerResult,
    latencyMs: number,
    agentConfig: AgentConfig,
    nodeRow: NodeRow,
  ): Promise<{
    tokensInput: number;
    tokensOutput: number;
    modelRealName: string | null;
    usageSuspect: boolean;
  }> {
    const tokensInput = runnerResult.tokensInput ?? 0;
    // Fall back to the historical all-in-one total when the executor hasn't
    // reported the split, so a reader of tokens_output sees no regression —
    // the row is still marked suspect below via tokensInput===0.
    const tokensOutput = runnerResult.tokensOutput ?? runnerResult.tokensSpent;
    const rateSuspect = computeUsageSuspect({
      tokensInput,
      tokensOutput,
      latencyMs,
    });

    let modelRealName: string | null = null;
    let nameSuspect = false;
    try {
      const resolved = await resolveRealName(
        agentConfig.model,
        nodeRow.ownerEmail,
      );
      modelRealName = resolved.realName;
      nameSuspect = resolved.suspect;
    } catch (err) {
      // Registry lookup must never fail a spawn write (best-effort telemetry).
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[v3-dispatcher] model-registry lookup failed: ${msg}`);
    }

    return {
      tokensInput,
      tokensOutput,
      modelRealName,
      usageSuspect: rateSuspect || nameSuspect,
    };
  }

  private async writeSpawnRecord(opts: {
    spawnId: string;
    nodeRow: NodeRow;
    agentConfig: AgentConfig;
    renderedPrompt: string;
    startedAt: Date;
    completedAt: Date;
    status: "done" | "failed" | "running" | "cancelled";
    outputKind: string;
    outputArtifactId: string | null;
    workspaceId: string | null;
    tokensInput: number;
    tokensOutput: number;
    latencyMs: number;
    error: string | null;
    errorClass: ErrorClass | null;
    vmName: string | null;
    /** F7 telemetry (04 §7): the model's real weight name, reverse-looked-up from `agentConfig.model` against the registry. Null when never resolved. */
    modelRealName: string | null;
    /** F7 telemetry (04 §7/§10): 1 when this row's usage/attribution should be excluded from aggregated metrics. */
    usageSuspect: boolean;
    /**
     * Count of `spawn_events` rows persisted for this spawn. When > 0 we point
     * `log_ref` at the spawn_events transcript (`spawn-events://<spawnId>`) so
     * the column — historically always null — now records that a real
     * intermediate transcript exists for this spawn (DESIGN §8.5).
     */
    spawnEventCount?: number;
  }): Promise<void> {
    const logRef =
      opts.spawnEventCount && opts.spawnEventCount > 0
        ? `spawn-events://${opts.spawnId}`
        : null;
    const values = {
      id: opts.spawnId,
      nodeId: opts.nodeRow.id,
      attempt: 1,
      agentName: opts.agentConfig.name,
      engineRef: opts.agentConfig.engine || null,
      modelRef: opts.agentConfig.model || null,
      runtime: opts.agentConfig.runtime,
      workspaceId: opts.workspaceId,
      renderedPrompt: opts.renderedPrompt,
      logRef,
      vmName: opts.vmName,
      acpSessionId: null,
      status: opts.status,
      outputArtifactId: opts.outputArtifactId,
      outputKind: opts.outputKind,
      tokensInput: opts.tokensInput,
      tokensOutput: opts.tokensOutput,
      latencyMs: opts.latencyMs,
      error: opts.error,
      errorClass: opts.errorClass,
      modelRealName: opts.modelRealName,
      usageSuspect: opts.usageSuspect ? 1 : 0,
      tags: null,
      startedAt: opts.startedAt,
      completedAt: opts.completedAt,
      ownerEmail: opts.nodeRow.ownerEmail,
      orgId: opts.nodeRow.orgId,
    };
    // UPSERT: openRunningSpawn() already inserted this row (status running) so
    // the live transcript could stream. Update it to the terminal state here.
    // Fall back to a plain insert when the early open was skipped/failed.
    await this.db
      .insert(v3Spawns)
      .values(values)
      .onConflictDoUpdate({
        target: v3Spawns.id,
        set: {
          status: opts.status,
          logRef,
          vmName: opts.vmName,
          outputArtifactId: opts.outputArtifactId,
          outputKind: opts.outputKind,
          tokensInput: opts.tokensInput,
          tokensOutput: opts.tokensOutput,
          latencyMs: opts.latencyMs,
          error: opts.error,
          errorClass: opts.errorClass,
          modelRealName: opts.modelRealName,
          usageSuspect: opts.usageSuspect ? 1 : 0,
          completedAt: opts.completedAt,
        },
      });
  }

  private async failNode(
    nodeRow: NodeRow,
    error: string,
    errorClass: ErrorClass,
  ): Promise<void> {
    await this.db
      .update(v3Nodes)
      .set({
        status: "failed",
        error: error.slice(0, 1000),
        completedAt: new Date(),
      })
      .where(eq(v3Nodes.id, nodeRow.id));
  }

  // ── Private: DAG resolution ──────────────────────────────────────────────

  /**
   * Load DAG from v3_runs for a given run. Returns an array of node objects
   * from the stored DAG JSON.
   */
  private async loadDagForRun(runId: string): Promise<V3Node[]> {
    const [run] = await this.db
      .select()
      .from(v3Runs)
      .where(eq(v3Runs.id, runId));

    if (!run) return [];

    const dagRaw = run.dag as Record<string, unknown> | null;
    if (!dagRaw || typeof dagRaw !== "object") return [];

    const nodes = dagRaw.nodes as V3Node[] | undefined;
    return Array.isArray(nodes) ? nodes : [];
  }

  /** Find a DAG node by id. */
  private findDagNode(dag: V3Node[], nodeId: string): V3Node | undefined {
    return dag.find((n) => n.id === nodeId);
  }

  /** Get dependency ids for a node from the DAG. */
  private getNodeDeps(nodeRow: NodeRow, dag: V3Node[]): string[] {
    const dagNode = this.findDagNode(dag, nodeRow.nodeIdInDag);
    if (!dagNode) return [];

    const deps = (dagNode as { deps?: string[] }).deps;
    return Array.isArray(deps) ? deps : [];
  }
}

// ── Export error classification utilities for callers ────────────────────────

/**
 * Classify an error into V3 error class.
 * Used by the reconciler to determine cascade behavior.
 */
export function classifyNodeError(error: unknown): ErrorClass {
  return classifyErrorClass(error);
}

/**
 * Get the NodeRunner onFailure policy for a V3 error class.
 */
export function errorClassToOnFailurePolicy(
  errorClass: ErrorClass,
): NodeRuntimeSpec["onFailure"] {
  return errorClassToOnFailure(errorClass);
}
