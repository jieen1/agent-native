// V3 Health Check (DESIGN §9, IMPLEMENTATION §D).
// GET /_v3/health — returns JSON health report.
// Checks: Postgres connection, msb CLI, KVM backend, network egress.

import { defineEventHandler } from "h3";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Health status for a single check. */
interface HealthStatus {
  status: "ok" | "fail";
  message?: string;
}

/** Full health report shape. */
interface V3HealthReport {
  postgres: HealthStatus;
  msb: HealthStatus;
  kvm: HealthStatus;
  egress: HealthStatus;
}

/**
 * Check Postgres connectivity by running a lightweight query.
 */
async function checkPostgres(): Promise<HealthStatus> {
  try {
    const { v3DbExec } = await import("../db/v3.js");
    await v3DbExec("SELECT 1");
    return { status: "ok" };
  } catch (error: unknown) {
    return {
      status: "fail",
      message: error instanceof Error ? error.message : "Postgres unreachable",
    };
  }
}

/**
 * Check msb CLI availability by running `msb --version`.
 */
async function checkMsbCli(): Promise<HealthStatus> {
  try {
    const { stdout } = await execFileP("msb", ["--version"], {
      timeout: 5_000,
    });
    return { status: "ok", message: stdout.trim() };
  } catch (error: unknown) {
    return {
      status: "fail",
      message:
        error instanceof Error
          ? error.message
          : "msb CLI not found or timed out",
    };
  }
}

/**
 * Detect KVM backend availability in WSL2 environment.
 * Checks for /dev/kvm device which indicates KVM passthrough is configured.
 */
async function checkKvm(): Promise<HealthStatus> {
  try {
    // Check if running in WSL2 first
    const { stdout: release } = await execFileP("uname", ["-r"], {
      timeout: 5_000,
    });
    const isWsl = release.toLowerCase().includes("microsoft");

    if (!isWsl) {
      // Not WSL — check for /dev/kvm directly (Linux native)
      await execFileP("test", ["-e", "/dev/kvm"], {
        timeout: 3_000,
      });
      return { status: "ok", message: "KVM device available" };
    }

    // WSL2: check for /dev/kvm (WSL2 KVM passthrough)
    await execFileP("test", ["-e", "/dev/kvm"], {
      timeout: 3_000,
    });
    return { status: "ok", message: "WSL2 KVM passthrough available" };
  } catch (error: unknown) {
    return {
      status: "fail",
      message:
        error instanceof Error
          ? `KVM not available: ${error.message}`
          : "KVM not available",
    };
  }
}

/**
 * Check network egress by performing a lightweight HTTP check.
 */
async function checkEgress(): Promise<HealthStatus> {
  try {
    await execFileP(
      "curl",
      [
        "-s",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "--max-time",
        "5",
        "https://www.google.com",
      ],
      {
        timeout: 8_000,
      },
    );
    return { status: "ok" };
  } catch (error: unknown) {
    return {
      status: "fail",
      message:
        error instanceof Error
          ? `Egress check failed: ${error.message}`
          : "Network egress unavailable",
    };
  }
}

/**
 * GET /_v3/health
 *
 * Returns a JSON health report covering Postgres, msb CLI, KVM backend,
 * and network egress. All checks run in parallel.
 */
export const v3HealthEventHandler = defineEventHandler(async (): Promise<V3HealthReport> => {
  const [postgres, msb, kvm, egress] = await Promise.all([
    checkPostgres(),
    checkMsbCli(),
    checkKvm(),
    checkEgress(),
  ]);

  return {
    postgres,
    msb,
    kvm,
    egress,
  };
});
