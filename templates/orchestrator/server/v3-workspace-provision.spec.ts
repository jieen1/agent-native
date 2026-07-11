// F1 workspace contract — W2 (dependency prewarming) / W3 (test-executability
// smoke) supply-pipeline tests (T-F1-06, T-F1-07 — docs/sdlc-impl-f1-f4.md
// §6.1). Logic paths use an injected `exec`; the W3 "real test cases actually
// execute" half (T-F1-07's anti-empty-dir check) runs a REAL nested vitest
// subprocess over a temp fixture — no mocked green.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  execCmd,
  assertDependenciesWarm,
  runTestCmdSmoke,
  resolvePnpmStoreDir,
  resolveTestCmdSmoke,
  DEFAULT_TEST_CMD_SMOKE,
  WorkspaceNotReadyError,
  DiffBaseUnresolvableError,
  type ExecResult,
} from "./v3-workspace-provision.js";

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tempDirs.splice(0))
    rmSync(d, { recursive: true, force: true });
  delete process.env.ORCH_PNPM_STORE;
});

function ok(stdout = "ok"): ExecResult {
  return { code: 0, stdout, stderr: "", timedOut: false, durationMs: 1 };
}
function fail(code = 1, stderr = "boom"): ExecResult {
  return { code, stdout: "", stderr, timedOut: false, durationMs: 1 };
}

// ── Error classes (T-F1-08 semantics at the type level) ─────────────────────

describe("readiness error classes", () => {
  it("WorkspaceNotReadyError carries stage + errorClass='infra' (never an agent failure)", () => {
    const err = new WorkspaceNotReadyError("W3", "smoke failed");
    expect(err.name).toBe("WorkspaceNotReadyError");
    expect(err.stage).toBe("W3");
    expect(err.errorClass).toBe("infra");
    expect(err.message).toContain("W3");
    expect(err.message).toContain("smoke failed");
    expect(err).toBeInstanceOf(Error);
  });

  it("DiffBaseUnresolvableError carries dir/targetBranch/detail", () => {
    const err = new DiffBaseUnresolvableError(
      "/ws/x",
      "main",
      "no common ancestor",
    );
    expect(err.name).toBe("DiffBaseUnresolvableError");
    expect(err.dir).toBe("/ws/x");
    expect(err.targetBranch).toBe("main");
    expect(err.message).toContain("main");
    expect(err.message).toContain("no common ancestor");
  });
});

// ── execCmd (the real subprocess runner both W2 and W3 ride on) ─────────────

describe("execCmd", () => {
  it("runs a real command and captures exit code + stdout", async () => {
    const res = await execCmd("node --version", {
      cwd: process.cwd(),
      timeoutMs: 15_000,
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/^v\d+/);
    expect(res.timedOut).toBe(false);
  });

  it("returns non-zero exit codes instead of throwing", async () => {
    const res = await execCmd("exit 7", {
      cwd: process.cwd(),
      timeoutMs: 15_000,
    });
    expect(res.code).toBe(7);
  });

  it("kills a runaway command at timeoutMs and reports timedOut (bounded, never hangs)", async () => {
    const startedAt = Date.now();
    const res = await execCmd("sleep 30", {
      cwd: process.cwd(),
      timeoutMs: 300,
    });
    expect(res.timedOut).toBe(true);
    expect(res.code).toBe(-1);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });
});

// ── W2: assertDependenciesWarm (T-F1-06) ────────────────────────────────────

describe("assertDependenciesWarm (W2, T-F1-06)", () => {
  it("warm probe passes → ok without running pnpm install", async () => {
    const exec = vi.fn(async () => ok("3.2.4"));
    const report = await assertDependenciesWarm("/ws/dir", { exec });

    expect(report.ok).toBe(true);
    expect(report.installed).toBe(false);
    expect(report.probeOutput).toContain("3.2.4");
    expect(report.installOutput).toBeNull();
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    // Exactly one call — the probe. No install.
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][0]).toBe("pnpm exec vitest --version");
  });

  it("cold probe → pnpm install --prefer-offline --store-dir <shared store> → re-probe passes", async () => {
    process.env.ORCH_PNPM_STORE = "/workspaces/.custom-store";
    const calls: string[] = [];
    const exec = vi.fn(async (command: string) => {
      calls.push(command);
      if (calls.length === 1) return fail(1, "vitest: not found");
      return ok(calls.length === 2 ? "installed deps" : "3.2.4");
    });

    const report = await assertDependenciesWarm("/ws/dir", { exec });

    expect(report.ok).toBe(true);
    expect(report.installed).toBe(true);
    expect(calls).toHaveLength(3);
    // The supply pipeline owns the install (DESIGN §7: 职责归供给,不归 agent),
    // and it MUST ride the shared hardlink store (seconds, not minutes).
    expect(calls[1]).toContain("pnpm install --prefer-offline");
    expect(calls[1]).toContain('--store-dir "/workspaces/.custom-store"');
    expect(report.installOutput).toContain("installed deps");
  });

  it("re-probe still failing after install → WorkspaceNotReadyError('W2')", async () => {
    const exec = vi.fn(async () => fail(1, "vitest: not found"));

    await expect(
      assertDependenciesWarm("/ws/dir", { exec }),
    ).rejects.toMatchObject({
      name: "WorkspaceNotReadyError",
      stage: "W2",
      errorClass: "infra",
    });
  });

  it("resolvePnpmStoreDir defaults to /workspaces/.pnpm-store and honours ORCH_PNPM_STORE", () => {
    delete process.env.ORCH_PNPM_STORE;
    expect(resolvePnpmStoreDir()).toBe("/workspaces/.pnpm-store");
    process.env.ORCH_PNPM_STORE = "/mnt/store";
    expect(resolvePnpmStoreDir()).toBe("/mnt/store");
  });
});

// ── W3: runTestCmdSmoke (T-F1-07) ───────────────────────────────────────────

describe("runTestCmdSmoke (W3, T-F1-07)", () => {
  it("default command carries --passWithNoTests; a project override replaces it entirely", () => {
    expect(DEFAULT_TEST_CMD_SMOKE).toContain("--passWithNoTests");
    expect(resolveTestCmdSmoke(undefined)).toBe(DEFAULT_TEST_CMD_SMOKE);
    expect(resolveTestCmdSmoke("  my-custom-smoke --flag  ")).toBe(
      "my-custom-smoke --flag",
    );
  });

  it("injection: a smoke command exiting non-zero → WorkspaceNotReadyError('W3'), report never produced", async () => {
    await expect(
      runTestCmdSmoke(process.cwd(), { command: "exit 1" }),
    ).rejects.toMatchObject({
      name: "WorkspaceNotReadyError",
      stage: "W3",
      errorClass: "infra",
    });
  });

  it("a smoke command exceeding the timeout → WorkspaceNotReadyError('W3') (bounded)", async () => {
    await expect(
      runTestCmdSmoke(process.cwd(), { command: "sleep 30", timeoutMs: 300 }),
    ).rejects.toMatchObject({ name: "WorkspaceNotReadyError", stage: "W3" });
  });

  it("REAL execution: with --passWithNoTests removed, >=1 real test case must run — an EMPTY fixture fails W3 (no empty-dir false green)", async () => {
    // The orchestrator repo root (where vitest + its config live). At test
    // runtime this is the template dir the parent vitest was launched from.
    const repoRoot = process.cwd();
    const vitestBin = join(repoRoot, "node_modules", "vitest", "vitest.mjs");
    if (!existsSync(vitestBin)) {
      throw new Error(
        `vitest binary not found at ${vitestBin} — cannot run the real-execution half of T-F1-07`,
      );
    }

    // Fixture WITH one real passing test. `server/` prefix so the template's
    // vitest.config include pattern (server/**/*.spec.ts) matches under --dir.
    const withTest = tempDir("f1-smoke-real-");
    mkdirSync(join(withTest, "server"), { recursive: true });
    writeFileSync(
      join(withTest, "server", "sample.spec.ts"),
      `import { it, expect } from "vitest";\nit("real case", () => { expect(1 + 1).toBe(2); });\n`,
    );

    // NO --passWithNoTests: green requires >=1 actually-executed test case.
    const command = `node ${vitestBin} run --dir ${withTest} --reporter=dot`;
    const report = await runTestCmdSmoke(repoRoot, {
      command,
      timeoutMs: 120_000,
    });

    expect(report.ok).toBe(true);
    expect(report.exitCode).toBe(0);
    // >=1 REAL test case executed (parsed from the reporter output).
    expect(report.testsRun).not.toBeNull();
    expect(report.testsRun!).toBeGreaterThanOrEqual(1);

    // Same command over an EMPTY fixture: vitest exits non-zero ("no test
    // files found") → W3 blocks readiness. This is the anti-false-green half.
    const empty = tempDir("f1-smoke-empty-");
    mkdirSync(join(empty, "server"), { recursive: true });
    await expect(
      runTestCmdSmoke(repoRoot, {
        command: `node ${vitestBin} run --dir ${empty} --reporter=dot`,
        timeoutMs: 120_000,
      }),
    ).rejects.toMatchObject({ name: "WorkspaceNotReadyError", stage: "W3" });
  }, 180_000);
});
