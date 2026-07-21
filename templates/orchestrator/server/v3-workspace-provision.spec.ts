// F1 workspace contract — W2 (dependency prewarming) / W3 (test-executability
// smoke) supply-pipeline tests (T-F1-06, T-F1-07 — docs/sdlc-impl-f1-f4.md
// §6.1). Logic paths use an injected `exec`; the W3 "real test cases actually
// execute" half (T-F1-07's anti-empty-dir check) runs a REAL nested vitest
// subprocess over a temp fixture — no mocked green.

import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, vi, afterEach } from "vitest";

import {
  execCmd,
  assertDependenciesWarm,
  runTestCmdSmoke,
  resolvePnpmStoreDir,
  resolveProbeTimeoutMs,
  resolveInstallTimeoutMs,
  resolveSmokeTimeoutMs,
  resolveTestCmdSmoke,
  resolveVitestProjectDir,
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
  delete process.env.ORCH_PNPM_PROBE_TIMEOUT_MS;
  delete process.env.ORCH_PNPM_INSTALL_TIMEOUT_MS;
  delete process.env.ORCH_SMOKE_TIMEOUT_MS;
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
    expect(exec.mock.calls[0]?.[0 as number]).toBe(
      "pnpm exec vitest --version",
    );
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

// ── resolveVitestProjectDir (SDLC-0xx dogfood false positive, board #47/#72) ─
//
// The dogfood project's repo is a MIRROR OF THIS MONOREPO: `dir` passed to W2/
// W3 is the pnpm WORKSPACE root, whose own package.json never lists `vitest`
// (every template/package declares it individually). `pnpm exec vitest
// --version` run there can never succeed even after a fully successful `pnpm
// install` (ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL) — these tests exercise the
// real filesystem-walk fix directly, with REAL temp-dir fixtures (no mocked
// resolution).

describe("resolveVitestProjectDir (monorepo-aware W2/W3 routing)", () => {
  it("returns dir unchanged when dir's own package.json already declares vitest (standalone repo — zero behavior change)", async () => {
    const root = tempDir("f1-vitest-standalone-");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ devDependencies: { vitest: "^4.1.5" } }),
    );
    await expect(resolveVitestProjectDir(root)).resolves.toBe(root);
  });

  it("walks one level down (this repo's own templates/<app> shape) for the first package declaring vitest", async () => {
    const root = tempDir("f1-vitest-mono-l1-");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root" }));
    const appDir = join(root, "templates", "orchestrator");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, "package.json"),
      JSON.stringify({ devDependencies: { vitest: "catalog:" } }),
    );

    await expect(resolveVitestProjectDir(root)).resolves.toBe(appDir);
  });

  it("ignores node_modules and dotdirs while walking (never picks a vendored copy)", async () => {
    const root = tempDir("f1-vitest-skip-");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root" }));
    mkdirSync(join(root, "node_modules", "vitest"), { recursive: true });
    writeFileSync(
      join(root, "node_modules", "vitest", "package.json"),
      JSON.stringify({ devDependencies: { vitest: "^4.1.5" } }),
    );
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(
      join(root, ".git", "package.json"),
      JSON.stringify({ devDependencies: { vitest: "^4.1.5" } }),
    );

    await expect(resolveVitestProjectDir(root)).resolves.toBe(root);
  });

  it("falls back to dir when NO package anywhere declares vitest (genuinely broken/non-monorepo workspace — never widens what counts as warm)", async () => {
    const root = tempDir("f1-vitest-broken-");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root" }));
    const pkgDir = join(root, "some-pkg");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ dependencies: { lodash: "^4.0.0" } }),
    );

    await expect(resolveVitestProjectDir(root)).resolves.toBe(root);
  });
});

describe("assertDependenciesWarm — monorepo routing (SDLC-0xx dogfood false positive)", () => {
  it("cold monorepo checkout: probe/reprobe scope into the vitest-declaring subdir; install still targets the workspace root", async () => {
    const root = tempDir("f1-w2-mono-cold-");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root" }));
    const appDir = join(root, "templates", "orchestrator");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, "package.json"),
      JSON.stringify({ devDependencies: { vitest: "catalog:" } }),
    );

    const calls: { command: string; cwd: string }[] = [];
    const exec = vi.fn(async (command: string, opts: { cwd: string }) => {
      calls.push({ command, cwd: opts.cwd });
      if (command.startsWith("pnpm install"))
        return ok("installed workspace deps");
      // First call is the cold probe (miss); second is the post-install reprobe.
      return calls.length === 1
        ? fail(254, "ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL")
        : ok("4.1.9");
    });

    const report = await assertDependenciesWarm(root, { exec });

    expect(report.ok).toBe(true);
    expect(report.installed).toBe(true);
    expect(report.probeDir).toBe(appDir);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({
      command: "pnpm exec vitest --version",
      cwd: appDir,
    });
    expect(calls[1]?.command).toContain("pnpm install --prefer-offline");
    // Install is a whole-workspace operation — it ALWAYS targets dir itself,
    // never the resolved subdir (T-F1-06 regression: scoping it would just
    // reinstall the same workspace from a deeper cwd, no benefit, more risk).
    expect(calls[1]?.cwd).toBe(root);
    expect(calls[2]).toEqual({
      command: "pnpm exec vitest --version",
      cwd: appDir,
    });
  });

  it("warm monorepo checkout: a single probe scoped straight to the subdir — root is never touched", async () => {
    const root = tempDir("f1-w2-mono-warm-");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root" }));
    const appDir = join(root, "templates", "orchestrator");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, "package.json"),
      JSON.stringify({ devDependencies: { vitest: "catalog:" } }),
    );

    const exec = vi.fn(async (_command: string, _opts: { cwd: string }) =>
      ok("4.1.9"),
    );
    const report = await assertDependenciesWarm(root, { exec });

    expect(report.ok).toBe(true);
    expect(report.installed).toBe(false);
    expect(report.probeDir).toBe(appDir);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]?.[0]).toBe("pnpm exec vitest --version");
    expect(exec.mock.calls[0]?.[1]).toMatchObject({ cwd: appDir });
  });

  it("genuinely broken workspace (no package anywhere resolves vitest, even after install) still fails W2 — the fix must not weaken this", async () => {
    const root = tempDir("f1-w2-mono-broken-");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root" }));
    mkdirSync(join(root, "templates", "orchestrator"), { recursive: true });
    writeFileSync(
      join(root, "templates", "orchestrator", "package.json"),
      JSON.stringify({ dependencies: {} }),
    );

    const exec = vi.fn(async (_command: string, _opts: { cwd: string }) =>
      fail(254, "ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL"),
    );

    await expect(assertDependenciesWarm(root, { exec })).rejects.toMatchObject({
      name: "WorkspaceNotReadyError",
      stage: "W2",
      errorClass: "infra",
    });
    // The probe/reprobe/install all ran at dir (root) — resolveVitestProjectDir
    // found nothing to scope into, so behavior is byte-for-byte the pre-fix path.
    expect(exec.mock.calls.every((c) => c[1]?.cwd === root)).toBe(true);
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

// ── runTestCmdSmoke — monorepo routing (SDLC-0xx dogfood false positive) ────

describe("runTestCmdSmoke — monorepo routing", () => {
  it("default command scopes into the vitest-declaring subdir for a monorepo root", async () => {
    const root = tempDir("f1-w3-mono-default-");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root" }));
    const appDir = join(root, "templates", "orchestrator");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, "package.json"),
      JSON.stringify({ devDependencies: { vitest: "catalog:" } }),
    );

    const exec = vi.fn(async (_command: string, _opts: { cwd: string }) =>
      ok("Tests 1 passed"),
    );
    const report = await runTestCmdSmoke(root, { exec });

    expect(report.ok).toBe(true);
    expect(report.execDir).toBe(appDir);
    expect(exec.mock.calls[0]?.[0]).toBe(DEFAULT_TEST_CMD_SMOKE);
    expect(exec.mock.calls[0]?.[1]).toMatchObject({ cwd: appDir });
  });

  it("an explicit project-level override still runs at dir itself, even in a monorepo shape (operator owns the cwd contract)", async () => {
    const root = tempDir("f1-w3-mono-override-");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root" }));
    mkdirSync(join(root, "templates", "orchestrator"), { recursive: true });
    writeFileSync(
      join(root, "templates", "orchestrator", "package.json"),
      JSON.stringify({ devDependencies: { vitest: "catalog:" } }),
    );

    const exec = vi.fn(async (_command: string, _opts: { cwd: string }) =>
      ok("Tests 1 passed"),
    );
    const report = await runTestCmdSmoke(root, {
      exec,
      command: "./scripts/custom-smoke.sh",
    });

    expect(report.execDir).toBe(root);
    expect(exec.mock.calls[0]?.[1]).toMatchObject({ cwd: root });
  });

  it("a genuinely broken monorepo (no package resolves vitest) still fails W3", async () => {
    const root = tempDir("f1-w3-mono-broken-");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root" }));
    mkdirSync(join(root, "templates", "orchestrator"), { recursive: true });
    writeFileSync(
      join(root, "templates", "orchestrator", "package.json"),
      JSON.stringify({ dependencies: {} }),
    );

    const exec = vi.fn(async (_command: string, _opts: { cwd: string }) =>
      fail(254, "ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL"),
    );

    await expect(runTestCmdSmoke(root, { exec })).rejects.toMatchObject({
      name: "WorkspaceNotReadyError",
      stage: "W3",
    });
  });
});

// ── REAL end-to-end reproduction against this repo's own monorepo root ──────
//
// This is the actual bug shape reported from 101 (task board #47/#72): the
// dogfood project's workspace IS a checkout of this same monorepo, and its
// root package.json genuinely does not declare vitest (confirmed below, not
// assumed) — every template declares it individually. No injected `exec`
// here — this spawns REAL `pnpm`/`vitest` subprocesses against the real
// checkout two directories up from this template, so it only proves the fix
// against a genuine monorepo shape, not a synthetic fixture.

describe("W2 real end-to-end reproduction (SDLC-0xx dogfood false positive)", () => {
  const monorepoRoot = join(process.cwd(), "..", "..");
  const looksLikeMonorepoRoot =
    existsSync(join(monorepoRoot, "pnpm-workspace.yaml")) &&
    existsSync(join(monorepoRoot, "package.json"));

  it.skipIf(!looksLikeMonorepoRoot)(
    "root package.json has no vitest of its own (the bug precondition) yet assertDependenciesWarm now resolves + passes",
    async () => {
      const rootPkg = JSON.parse(
        readFileSync(join(monorepoRoot, "package.json"), "utf8"),
      ) as {
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
      };
      expect(
        rootPkg.dependencies?.vitest ?? rootPkg.devDependencies?.vitest,
      ).toBeUndefined();

      const report = await assertDependenciesWarm(monorepoRoot, {
        probeTimeoutMs: 30_000,
        installTimeoutMs: 180_000,
      });

      expect(report.ok).toBe(true);
      // Proves the fix actually routed AWAY from the root (which is exactly
      // where the pre-fix probe always failed with
      // ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL) into a real workspace member.
      expect(report.probeDir).not.toBe(monorepoRoot);
      expect(report.probeDir.startsWith(monorepoRoot)).toBe(true);
      expect(report.probeOutput).toMatch(/\d+\.\d+\.\d+/);
    },
    180_000,
  );
});

// ── W2/W3 timeout resolution (board #88 — large monorepo installs need more ─
// headroom than a single-app repo's hardcoded 15s probe / 120s install / 120s
// smoke bounds allowed for. Distinct from board #72 (WHERE the probe/smoke
// command's cwd resolves — resolveVitestProjectDir, tested above): this is
// HOW LONG W2/W3 are allowed to run. Mirrors resolveGitTimeoutMs's env-var
// override pattern in v3-workspace-local.ts.

describe("W2/W3 timeout resolution (board #88)", () => {
  it("resolveProbeTimeoutMs defaults to 30s and honours ORCH_PNPM_PROBE_TIMEOUT_MS", () => {
    delete process.env.ORCH_PNPM_PROBE_TIMEOUT_MS;
    expect(resolveProbeTimeoutMs()).toBe(30_000);
    process.env.ORCH_PNPM_PROBE_TIMEOUT_MS = "45000";
    expect(resolveProbeTimeoutMs()).toBe(45_000);
  });

  it("resolveInstallTimeoutMs defaults to 300s (raised from the old 120s — a large monorepo's whole-workspace install + postinstall builds is heavier than a bare git fetch) and honours ORCH_PNPM_INSTALL_TIMEOUT_MS", () => {
    delete process.env.ORCH_PNPM_INSTALL_TIMEOUT_MS;
    expect(resolveInstallTimeoutMs()).toBe(300_000);
    process.env.ORCH_PNPM_INSTALL_TIMEOUT_MS = "600000";
    expect(resolveInstallTimeoutMs()).toBe(600_000);
  });

  it("resolveSmokeTimeoutMs defaults to 180s and honours ORCH_SMOKE_TIMEOUT_MS", () => {
    delete process.env.ORCH_SMOKE_TIMEOUT_MS;
    expect(resolveSmokeTimeoutMs()).toBe(180_000);
    process.env.ORCH_SMOKE_TIMEOUT_MS = "240000";
    expect(resolveSmokeTimeoutMs()).toBe(240_000);
  });

  it("a non-numeric/zero/negative env value falls back to the default (never NaN or a hung 0ms bound)", () => {
    process.env.ORCH_PNPM_INSTALL_TIMEOUT_MS = "not-a-number";
    expect(resolveInstallTimeoutMs()).toBe(300_000);
    process.env.ORCH_PNPM_INSTALL_TIMEOUT_MS = "0";
    expect(resolveInstallTimeoutMs()).toBe(300_000);
    process.env.ORCH_PNPM_INSTALL_TIMEOUT_MS = "-5";
    expect(resolveInstallTimeoutMs()).toBe(300_000);
  });

  it("assertDependenciesWarm uses the resolved (env-overridable) probe/install timeouts when the caller passes none — production's actual call shape (assertWorkspaceReady never passes explicit timeouts)", async () => {
    process.env.ORCH_PNPM_PROBE_TIMEOUT_MS = "9999";
    process.env.ORCH_PNPM_INSTALL_TIMEOUT_MS = "8888";
    const root = tempDir("f1-w2-timeout-resolve-");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ devDependencies: { vitest: "^4.1.5" } }),
    );

    const exec = vi.fn(
      async (command: string, _execOpts: { timeoutMs: number }) =>
        command.includes("install") ? fail(1, "offline") : ok("4.1.5"),
    );
    // First probe misses (forces the install path), so both probeTimeoutMs
    // (the initial probe) AND installTimeoutMs get exercised in one call.
    exec.mockImplementationOnce(
      async (_command: string, _execOpts: { timeoutMs: number }) =>
        fail(1, "cold"),
    );

    await assertDependenciesWarm(root, { exec });

    const probeCalls = exec.mock.calls.filter(
      (c) => !String(c[0]).includes("install"),
    );
    const installCalls = exec.mock.calls.filter((c) =>
      String(c[0]).includes("install"),
    );
    expect(probeCalls.every((c) => c[1].timeoutMs === 9999)).toBe(true);
    expect(installCalls.every((c) => c[1].timeoutMs === 8888)).toBe(true);
  });

  it("runTestCmdSmoke uses the resolved (env-overridable) smoke timeout when the caller passes none", async () => {
    process.env.ORCH_SMOKE_TIMEOUT_MS = "7777";
    const exec = vi.fn(
      async (_command: string, _execOpts: { timeoutMs: number }) =>
        ok("Tests 1 passed"),
    );

    await runTestCmdSmoke(process.cwd(), { exec });

    expect(exec.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: 7777 });
  });
});
