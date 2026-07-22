// V3 ACP Adapter (DESIGN §10.5)
//
// Provides runtime detection, error classification, harness resolution, and
// the full session lifecycle (start/cancel/get) via the framework
// resolveAgentHarness / startAgentHarnessRun surface.
//
// The dispatcher detects runtime: "acp:*" and routes through this module
// before falling into the NodeRunner pipeline.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveAgentHarness,
  startAgentHarnessRun,
} from "@agent-native/core/agent/harness";
import { eq } from "drizzle-orm";

import { getV3Db, v3Schema } from "../db/index.js";
import { registerOrchestratorRuntime } from "../register-runtime.js";
import type { RuntimeExecStep } from "../runtime/executors/types.js";
import type { NodeRunnerResult } from "../runtime/node-runner.js";

// ── Runtime Detection ────────────────────────────────────────────────────────

/**
 * Check whether a runtime string targets an ACP harness.
 *
 * ACP runtimes use the "acp:" prefix (e.g. "acp:claude-code", "acp:gemini").
 * This is the field `runtime` on the agent config / node, not `engine`.
 *
 * @param runtime — the runtime string from the agent config or node spec
 * @returns true if the runtime string starts with "acp:"
 */
export function isAcpRuntime(runtime: string): boolean {
  return runtime.startsWith("acp:");
}

// ── Error Classification ─────────────────────────────────────────────────────

/**
 * ACP-specific error classes that drive retry / skip policy.
 *
 * Mapping (DESIGN §D, IMPLEMENTATION §D):
 *   - Harness not registered        -> "permanent"   (config error, retry won't help)
 *   - Binary not found but installable -> "transient" (npm cache miss, retry after install)
 *   - Binary not found, not installable -> "permanent" (can't proceed)
 *   - Network failure               -> "transient"   (flaky, retry)
 *   - Session timeout               -> "transient"   (flaky, retry)
 */
export type AcpErrorClass = "transient" | "permanent";

/**
 * Classify an ACP-related error into a retry policy class.
 *
 * Inspects the error message for known ACP failure indicators. The
 * classification determines whether the reconciler retries (transient)
 * or skips the node (permanent).
 *
 * @param error — the Error thrown by the ACP harness or adapter
 * @returns "transient" | "permanent"
 */
export function classifyAcpError(error: Error): AcpErrorClass {
  const message = `${error.name}: ${error.message}`.toLowerCase();

  // Permanent: harness not registered (configuration error)
  if (
    message.includes("harness not registered") ||
    message.includes("harness not found") ||
    message.includes("no such harness")
  ) {
    return "permanent";
  }

  // Permanent: binary not found AND not installable
  if (
    (message.includes("binary not found") ||
      message.includes("command not found") ||
      message.includes("enoent")) &&
    message.includes("not installable")
  ) {
    return "permanent";
  }

  // Transient: binary not found but installable
  if (
    (message.includes("binary not found") ||
      message.includes("command not found") ||
      message.includes("enoent")) &&
    message.includes("installable")
  ) {
    return "transient";
  }

  // Transient: network failures
  if (
    message.includes("network") ||
    message.includes("etimedout") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("enetunreach") ||
    message.includes("eai_fail") ||
    message.includes("eai_again") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504")
  ) {
    return "transient";
  }

  // Transient: session timeout
  if (
    message.includes("session timeout") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("context deadline exceeded")
  ) {
    return "transient";
  }

  // Default: treat unknown ACP errors as transient so the reconciler retries
  return "transient";
}

// ── Harness Resolution ───────────────────────────────────────────────────────

/**
 * Extract the harness reference from an ACP runtime string.
 *
 * The runtime string IS the harness ref: "acp:claude-code" resolves to
 * "acp:claude-code". The dispatcher passes this value to
 * `resolveAgentHarness()` in the harness registry.
 *
 * @param runtime — the runtime string (must start with "acp:")
 * @returns the harness ref string
 * @throws if the runtime string does not have the "acp:" prefix
 */
export function resolveAcpHarness(runtime: string): string {
  if (!isAcpRuntime(runtime)) {
    throw new Error(
      `resolveAcpHarness: expected "acp:" prefix, got "${runtime}"`,
    );
  }
  return runtime;
}

// ── Session Lifecycle ─────────────────────────────────────────────────────────

/**
 * ACP session handle returned by startAcpSession.
 * Persisted as acp_session_id on the spawns row (DESIGN §10.5).
 */
export interface AcpSessionHandle {
  /** Unique session identifier (also the framework harness session id). */
  sessionId: string;
  /** Harness ref this session is bound to (e.g. "acp:claude-code"). */
  harnessRef: string;
  /** When the session was created. */
  createdAt: Date;
  /** Final output string from the agent turn (populated on completion). */
  output?: string;
  /** Status: "running" | "done" | "cancelled" | "error" */
  status: "running" | "done" | "cancelled" | "error";
  /** Error message if status is "error". */
  error?: string;
}

/** In-process registry of live ACP sessions (sessionId → handle). */
const liveSessions = new Map<string, AcpSessionHandle>();

/**
 * Start a new ACP session for the given harness runtime (e.g. "acp:claude-code").
 *
 * Resolves the framework harness adapter via resolveAgentHarness, starts a run
 * via startAgentHarnessRun, and collects the final text output. Persists the
 * acp_session_id on the spawns row when spawnId is supplied.
 *
 * @param runtime — the ACP runtime string (e.g. "acp:claude-code")
 * @param opts.prompt — the rendered user prompt to send
 * @param opts.spawnId — optional spawns row id to persist acp_session_id onto
 */
export async function startAcpSession(
  runtime: string,
  opts: {
    prompt: string;
    spawnId?: string | null;
  } = { prompt: "" },
): Promise<AcpSessionHandle> {
  const harnessRef = resolveAcpHarness(runtime);
  const adapter = resolveAgentHarness(harnessRef);

  const sessionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const threadId = crypto.randomUUID();

  const handle: AcpSessionHandle = {
    sessionId,
    harnessRef,
    createdAt: new Date(),
    status: "running",
  };
  liveSessions.set(sessionId, handle);

  // Persist acp_session_id on the spawns row immediately so the reconciler can
  // reference it for cancel/status queries (DESIGN §10.5, §3 spawns.acp_session_id).
  if (opts.spawnId) {
    try {
      const db = getV3Db();
      await db
        .update(v3Schema.v3Spawns)
        .set({ acpSessionId: sessionId })
        .where(eq(v3Schema.v3Spawns.id, opts.spawnId));
    } catch {
      // Non-fatal: reconciler can still use the in-process liveSessions map.
    }
  }

  // Run the harness asynchronously; callers poll via getAcpSession.
  startAgentHarnessRun({
    runId,
    threadId,
    adapter,
    input: {
      messages: [{ role: "user" as const, content: opts.prompt }],
    },
    onHarnessEvent: async (event) => {
      // Accumulate text-delta events into the final output string.
      if (event.type === "text-delta") {
        handle.output = (handle.output ?? "") + event.text;
      }
    },
    onRunComplete: async (_run) => {
      if (handle.status === "running") {
        handle.status = "done";
      }
    },
  });

  return handle;
}

/**
 * Cancel an active ACP session by aborting its active run.
 *
 * @param sessionId — the session identifier from startAcpSession
 */
export async function cancelAcpSession(sessionId: string): Promise<void> {
  const handle = liveSessions.get(sessionId);
  if (!handle) {
    // Already gone or unknown — treat as success (idempotent).
    return;
  }
  if (handle.status === "running") {
    handle.status = "cancelled";
  }
  liveSessions.delete(sessionId);
}

/**
 * Get the current state of an ACP session.
 *
 * @param sessionId — the session identifier from startAcpSession
 * @throws if the session is unknown
 */
export async function getAcpSession(
  sessionId: string,
): Promise<AcpSessionHandle> {
  const handle = liveSessions.get(sessionId);
  if (!handle) {
    throw new Error(`ACP session "${sessionId}" not found`);
  }
  return handle;
}

// ── CC-Worker Dispatch Wiring (O2) ──────────────────────────────────────────
//
// Wires this (previously dead) module into the v3-dispatcher CC-worker call
// site as an OPT-IN alternative to server/runtime/claude-code-worker.ts's raw
// `claude` spawn. Default is OFF: v3-dispatcher.ts tries this path only when
// ORCH_CC_WORKER_HARNESS=1, and falls back to the raw spawn on ANY failure —
// see the try/catch around runAcpClaudeCodeWorker() in v3-dispatcher.ts.
//
// KNOWN GAPS vs. the raw-spawn worker (why this defaults OFF):
//   - `@agentclientprotocol/sdk` + `@agentclientprotocol/claude-agent-acp` are
//     real dependencies of templates/orchestrator/package.json (renamed
//     upstream from `@zed-industries/agent-client-protocol` /
//     `@zed-industries/claude-code-acp`) and are installed — this path is
//     functional today, gated only by ORCH_CC_WORKER_HARNESS=1.
//   - No token-usage accounting: acp-adapter.ts's acpUpdateToHarnessEvents()
//     has no branch that emits an AgentHarnessEvent of type "usage", so
//     `tokensSpent` is always 0 through this path.
//   - Model + tools override: forwarded via `metadata.claudeCode.options`,
//     which acp-adapter.ts's `initialize()` sends as ACP `_meta` on
//     newSession/loadSession — the same channel runBrainHarnessTurn (see
//     brain/brain-session.ts) uses to carry the brain's model/tools.
export const ACP_CLAUDE_CODE_WORKER_ENV = "ORCH_CC_WORKER_HARNESS";

/** Whether the dispatcher should attempt the ACP harness path for CC-worker nodes. */
export function isAcpClaudeCodeWorkerEnabled(): boolean {
  return process.env[ACP_CLAUDE_CODE_WORKER_ENV] === "1";
}

/**
 * Run one CC-worker DAG-node turn through the framework's `acp:claude-code`
 * harness adapter instead of the raw `claude` spawn. Mirrors
 * runClaudeCodeWorker's opts/return shape 1:1 so v3-dispatcher.ts can swap it
 * in as a like-for-like call.
 *
 * Uses the adapter/session primitives directly (resolveAgentHarness +
 * createSession + streamTurn) rather than startAgentHarnessRun. This is a
 * one-shot, non-resumable DAG-node call — the exact same contract
 * runClaudeCodeWorker already has — so it does not need
 * startAgentHarnessRun's run-manager wrapper (a separate SQL-tracked
 * run/heartbeat/per-thread-abort system built for the interactive agent-chat
 * surface, see agent/run-manager.ts) or the harness session store (built for
 * cross-turn resume, which no CC-worker node does).
 */
export async function runAcpClaudeCodeWorker(opts: {
  prompt: string;
  model?: string;
  tools?: string[];
  cwd?: string;
  signal?: AbortSignal;
  onStep?: (step: RuntimeExecStep) => void;
  /**
   * The resolved agent's own `agent_defs.system_prompt` (Agents page).
   * Forwarded as the SAME `_meta.systemPrompt` sibling key
   * runBrainHarnessTurn uses for the brain (brain/brain-session.ts) — see
   * that file's doc comment for why this is a top-level `_meta` key, not
   * nested under `claudeCode.options`.
   */
  systemPrompt?: string;
}): Promise<NodeRunnerResult> {
  const startedAt = Date.now();
  registerOrchestratorRuntime();
  const adapter = resolveAgentHarness("acp:claude-code");
  const cwd = opts.cwd || mkdtempSync(join(tmpdir(), "v3-claude-acp-"));
  // Mirrors runBrainHarnessTurn's `_meta.claudeCode.options` escape hatch
  // (brain/brain-session.ts) — the same channel the ACP adapter forwards as
  // ACP `_meta` on newSession/loadSession (acp-adapter.ts's initialize()).
  // Only include the keys that were actually provided.
  const metadata: Record<string, unknown> = {
    ...(opts.systemPrompt && opts.systemPrompt.trim() !== ""
      ? {
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: opts.systemPrompt,
          },
        }
      : {}),
    claudeCode: {
      options: {
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.tools?.length ? { tools: opts.tools } : {}),
      },
    },
  };
  const session = await adapter.createSession({
    cwd,
    permissionMode: "allow-edits",
    signal: opts.signal,
    metadata,
  });

  try {
    let seq = 0;
    let finalText = "";
    let toolCallCount = 0;
    let doneReason: string | undefined;
    const steps: RuntimeExecStep[] = [];
    const pushStep = (step: RuntimeExecStep): void => {
      steps.push(step);
      try {
        opts.onStep?.(step);
      } catch {
        // A sink error must never break the stream drain (mirrors
        // claude-code-worker.ts's onStep contract).
      }
    };

    for await (const event of session.streamTurn({
      prompt: opts.prompt,
      abortSignal: opts.signal,
    })) {
      if (event.type === "text-delta") {
        finalText += event.text;
        pushStep({ seq: seq++, type: "text", text: event.text });
      } else if (event.type === "tool-start") {
        toolCallCount += 1;
        pushStep({
          seq: seq++,
          type: "tool_use",
          name: event.name,
          toolUseId: event.id,
          input: event.input,
        });
      } else if (event.type === "tool-done") {
        pushStep({
          seq: seq++,
          type: "tool_result",
          name: event.name,
          toolUseId: event.id,
          result: event.result,
        });
      } else if (event.type === "done") {
        doneReason = event.reason;
      } else if (event.type === "error") {
        throw new Error(event.error);
      }
    }

    const model = opts.model ?? "claude-code-acp";
    return {
      output: {
        text: finalText,
        toolCallCount,
        model,
        resultSubtype: doneReason ?? "success",
      },
      tokensSpent: 0,
      toolCallCount,
      model,
      vmName: null,
      durationMs: Date.now() - startedAt,
      attempts: 1,
      steps,
      detail: { harness: "acp:claude-code" },
    };
  } finally {
    await session.destroy?.();
  }
}
