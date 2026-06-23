// V3 ACP Adapter — stub for P2 integration (DESIGN §10.5, IMPLEMENTATION §D)
//
// Provides runtime detection, error classification, and harness resolution
// for ACP (Agent Communication Protocol) harnesses. Full session lifecycle
// (start/cancel/get) is deferred to P3.
//
// The dispatcher detects runtime: "acp:*" and routes through this module
// before falling into the NodeRunner pipeline.

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
    message.includes("enetreunreachable") ||
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

// ── Session Lifecycle Stubs (P3) ─────────────────────────────────────────────

/**
 * ACP session handle returned by startAcpSession.
 * Full shape defined in P3 when session management is implemented.
 */
export interface AcpSessionHandle {
  /** Unique session identifier. */
  sessionId: string;
  /** Harness ref this session is bound to (e.g. "acp:claude-code"). */
  harnessRef: string;
  /** When the session was created. */
  createdAt: Date;
}

/**
 * Start a new ACP session for the given harness.
 *
 * @param runtime — the ACP runtime string (e.g. "acp:claude-code")
 * @throws "implement in P3"
 */
export async function startAcpSession(
  _runtime: string,
): Promise<AcpSessionHandle> {
  throw new Error("implement in P3");
}

/**
 * Cancel an active ACP session.
 *
 * @param sessionId — the session identifier from startAcpSession
 * @throws "implement in P3"
 */
export async function cancelAcpSession(_sessionId: string): Promise<void> {
  throw new Error("implement in P3");
}

/**
 * Get the current state of an ACP session.
 *
 * @param sessionId — the session identifier from startAcpSession
 * @throws "implement in P3"
 */
export async function getAcpSession(
  _sessionId: string,
): Promise<AcpSessionHandle> {
  throw new Error("implement in P3");
}
