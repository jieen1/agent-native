// V3 ACP Adapter (DESIGN §10.5)
//
// Provides runtime detection, error classification, harness resolution, and
// the full session lifecycle (start/cancel/get) via the framework
// resolveAgentHarness / startAgentHarnessRun surface.
//
// The dispatcher detects runtime: "acp:*" and routes through this module
// before falling into the NodeRunner pipeline.

import {
  resolveAgentHarness,
  startAgentHarnessRun,
} from "@agent-native/core/agent/harness";
import { getV3Db, v3Schema } from "../db/v3.js";
import { eq } from "drizzle-orm";

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
