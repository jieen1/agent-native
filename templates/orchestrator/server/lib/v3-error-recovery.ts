/**
 * P4-D: Error recovery utilities for the V3 orchestrator.
 *
 * Provides health probes for Postgres and microsandbox (msb), classifies
 * shim exit codes, and retries Postgres connections with exponential backoff.
 */

import { execSync, execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, dirname } from "node:path";

import { getDialect, isPostgres, getDbExec } from "@agent-native/core/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthCheck {
  /** Whether the target is currently reachable and responsive. */
  healthy: boolean;
  /** Human-readable detail about the result. */
  message: string;
  /** Suggested next action when healthy === false. */
  action: string;
}

export type ShimExitClassification = "success" | "permanent" | "transient";

export interface ShimExitInfo {
  classification: ShimExitClassification;
  signal?: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Postgres health
// ---------------------------------------------------------------------------

/**
 * Run a lightweight health probe against the current Postgres connection.
 *
 * Performs a `SELECT 1` through the shared DbExec client. On non-Postgres
 * dialects this short-circuits to a healthy result.
 */
export async function checkPostgresHealth(): Promise<HealthCheck> {
  if (!isPostgres()) {
    return {
      healthy: true,
      message: `Not on Postgres (dialect: ${getDialect()}); health check skipped.`,
      action: "none",
    };
  }

  try {
    const exec = getDbExec();
    const result = await exec.execute(`SELECT 1 AS alive`);
    const alive = result.rows?.[0] as Record<string, unknown> | undefined;

    if (alive?.alive === 1) {
      return {
        healthy: true,
        message: "Postgres connection is healthy (SELECT 1 succeeded).",
        action: "none",
      };
    }

    return {
      healthy: false,
      message: "Postgres returned unexpected result for health probe.",
      action: "restart_server",
    };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string })?.code;

    if (code === "ECONNREFUSED" || code === "ECONNRESET") {
      return {
        healthy: false,
        message: `Postgres connection refused or reset: ${detail}`,
        action: "restart_postgres",
      };
    }

    if (code === "CONNECT_TIMEOUT" || code === "ETIMEDOUT") {
      return {
        healthy: false,
        message: `Postgres connection timed out: ${detail}`,
        action: "check_network_and_restart",
      };
    }

    return {
      healthy: false,
      message: `Postgres health probe failed (${code ?? "unknown"}): ${detail}`,
      action: "investigate_and_restart",
    };
  }
}

// ---------------------------------------------------------------------------
// Microsandbox (msb) health
// ---------------------------------------------------------------------------

/**
 * Detect whether the microsandbox binary (`msb`) is available and responsive.
 *
 * Checks in this order:
 *  1. `MSB_PATH` env var (absolute path to the binary).
 *  2. `msb` on PATH.
 *  3. Fallback: try `which msb` / `where msb`.
 *
 * If the binary is found, runs `msb --version` to confirm it is executable.
 */
export function checkMsbHealth(): HealthCheck {
  // 1. Resolved binary path
  const msbPath = resolveMsbBinary();

  if (!msbPath) {
    return {
      healthy: false,
      message: "msb binary not found (not on PATH and MSB_PATH not set).",
      action: "install_microsandbox",
    };
  }

  if (!existsSync(msbPath)) {
    return {
      healthy: false,
      message: `msb binary missing at ${msbPath}.`,
      action: "install_microsandbox",
    };
  }

  // 2. Try version check to prove the binary is responsive
  try {
    const output = execFileSync(msbPath, ["--version"], {
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString().trim();

    return {
      healthy: true,
      message: `msb is reachable (${msbPath}): ${output}`,
      action: "none",
    };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);

    if ((error as { code?: string })?.code === "ETIMEDOUT") {
      return {
        healthy: false,
        message: `msb --version timed out (${msbPath}): ${detail}`,
        action: "restart_msb_or_check_kvm",
      };
    }

    if ((error as { status?: number })?.status !== undefined) {
      const status = (error as { status?: number }).status;
      if (status === 126) {
        return {
          healthy: false,
          message: `msb is not executable (${msbPath}).`,
          action: "chmod +x msb_binary",
        };
      }
      return {
        healthy: false,
        message: `msb --version exited with status ${status} (${msbPath}): ${detail}`,
        action: "check_kvm_and_msb",
      };
    }

    return {
      healthy: false,
      message: `msb health check failed (${msbPath}): ${detail}`,
      action: "check_kvm_and_msb",
    };
  }
}

/**
 * Resolve the absolute path to the `msb` binary.
 * Checks MSB_PATH first, then falls back to spawning `which`/`where`.
 */
function resolveMsbBinary(): string | null {
  // Priority 1: explicit env var
  const envPath = process.env.MSB_PATH;
  if (envPath) {
    return isAbsolute(envPath) ? envPath : null;
  }

  // Priority 2: resolve via platform which command
  try {
    const platform = process.platform;
    const whichCmd = platform === "win32" ? "where" : "which";
    const result = execSync(`${whichCmd} msb`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const paths = result.trim().split(/\r?\n/);
    return paths[0]?.trim() || null;
  } catch {
    // not on PATH
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shim exit code classification
// ---------------------------------------------------------------------------

/**
 * Classify a shim/sub-agent process exit code into a recovery category.
 *
 * | Exit Code | Classification | Cause                        |
 * |-----------|----------------|------------------------------|
 * | 0         | success        | Normal completion             |
 * | 137       | permanent      | SIGKILL (OOM kill by kernel)  |
 * | 139       | permanent      | SIGSEGV (segmentation fault)  |
 * | 134       | permanent      | SIGABRT (abort)               |
 * | other     | transient      | Application error, retryable  |
 */
export function classifyShimExitCode(exitCode: number): ShimExitInfo {
  switch (exitCode) {
    case 0:
      return {
        classification: "success",
        description: "Process completed successfully.",
      };

    case 137:
      return {
        classification: "permanent",
        signal: "SIGKILL",
        description:
          "Process killed by SIGKILL (exit 137) — likely OOM kill by kernel. Increase memory or reduce concurrency.",
      };

    case 139:
      return {
        classification: "permanent",
        signal: "SIGSEGV",
        description:
          "Process crashed with SIGSEGV (exit 139) — segmentation fault. Check binary compatibility and VM image.",
      };

    case 134:
      return {
        classification: "permanent",
        signal: "SIGABRT",
        description:
          "Process aborted with SIGABRT (exit 134) — explicit abort. Likely OOM or internal assertion failure.",
      };

    default:
      return {
        classification: "transient",
        description: `Non-zero exit code (${exitCode}) — likely an application-level or transient error. Retry may succeed.`,
      };
  }
}

// ---------------------------------------------------------------------------
// Postgres reconnect with retry
// ---------------------------------------------------------------------------

/**
 * Attempt to run an async operation against the current Postgres connection,
 * automatically retrying on connection errors with exponential backoff.
 *
 * On non-Postgres dialects the operation runs once (no retry).
 */
export async function reconnectWithRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
): Promise<T> {
  if (!isPostgres() || maxRetries < 1) {
    return operation();
  }

  let lastError: unknown;
  const baseDelay = 500; // ms

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: unknown) {
      lastError = error;
      const code = (error as { code?: string })?.code;

      // Only retry on connection-class errors
      const shouldRetry =
        attempt < maxRetries &&
        (code === "ECONNREFUSED" ||
          code === "ECONNRESET" ||
          code === "ETIMEDOUT" ||
          code === "CONNECT_TIMEOUT" ||
          code === "CONNECTION_CLOSED" ||
          code === "CONNECTION_ENDED" ||
          code === "EPIPE");

      if (!shouldRetry) {
        throw error;
      }

      const delay = baseDelay * Math.pow(2, attempt);
      // Small deterministic jitter to avoid thundering herd
      const jitter = Math.floor(Math.random() * delay * 0.1);

      await sleep(delay + jitter);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
