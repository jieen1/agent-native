// F1 workspace contract — full `createLocalWorkspace` flow over a REAL git
// fixture (temp upstream repo, real bare mirror + worktree under a temp
// ORCH_WORKSPACE_ROOT), with W2/W3 stubbed at the provision-module seam so no
// real `pnpm install`/vitest subprocess is needed here (those run for real in
// v3-workspace-provision.spec.ts).
//
// Covers: the W1→W2→W3 readiness sequencing inside createLocalWorkspace
// (ready_at/base_sha/ready_report land only after ALL pass — T-F1-05/06's
// bookkeeping half), and T-F1-07 注入 / T-F1-08's failure semantics (a W3
// smoke failure → row state `failed` + the ORIGINAL WorkspaceNotReadyError
// (stage/errorClass=infra) propagates + the checkout dir is cleaned up).

import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// ── Hoisted env: pin WORKSPACE_ROOT/BARE_ROOT (captured at module import) to
// a temp dir so the real mirror/worktree machinery never touches /workspaces.
// No fs call needed here — provisionWorktree/ensureBareMirror mkdir -p the
// root themselves; we only have to make the env var point somewhere unique.
const hoisted = vi.hoisted(() => {
  const workspaceRoot = `${process.env.TMPDIR?.replace(/\/$/, "") || "/tmp"}/f1-create-wsroot-${process.pid}-${Date.now()}`;
  process.env.ORCH_WORKSPACE_ROOT = workspaceRoot;
  return {
    workspaceRoot,
    rows: [] as Array<Record<string, unknown>>,
  };
});

// ── DB mock: capture the insert + apply updates to the inserted row. ────────
vi.mock("./db/index.js", () => ({
  getV3Db: () => ({
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        hoisted.rows.push(row);
        return {};
      },
    }),
    update: () => ({
      set: (data: Record<string, unknown>) => ({
        where: async () => {
          for (const row of hoisted.rows) Object.assign(row, data);
          return {};
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => hoisted.rows }),
      }),
    }),
  }),
  v3Schema: { v3Workspaces: { id: "id" } },
  LOCAL_DEFAULT_OWNER: "local@localhost",
}));

// ── Provision seam: keep the ERROR CLASSES real (instanceof must hold across
// the createLocalWorkspace boundary), stub the two subprocess-heavy stages.
vi.mock("./v3-workspace-provision.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./v3-workspace-provision.js")>();
  return {
    ...actual,
    assertDependenciesWarm: vi.fn(async () => ({
      ok: true,
      installed: false,
      probeOutput: "vitest/3 (stubbed)",
      installOutput: null,
      durationMs: 1,
    })),
    runTestCmdSmoke: vi.fn(async () => ({
      ok: true,
      command: "stubbed-smoke",
      exitCode: 0,
      output: "Tests 5 passed (stubbed)",
      testsRun: 5,
      durationMs: 1,
    })),
  };
});

// Keep token resolution fast + deterministic (no framework import attempt).
vi.mock("@agent-native/core/server", () => ({
  resolveSecret: async () => null,
}));

import {
  createLocalWorkspace,
  WorkspaceNotReadyError,
} from "./v3-workspace-local.js";
import {
  assertDependenciesWarm,
  runTestCmdSmoke,
} from "./v3-workspace-provision.js";

// ── Git fixture helpers ──────────────────────────────────────────────────────

function requireOk(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.error) throw res.error;
  if ((res.status ?? -1) !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${res.stderr || res.stdout}`,
    );
  }
  return (res.stdout ?? "").trim();
}

function makeUpstream(): { root: string; upstream: string; c0: string } {
  const root = mkdtempSync(join(tmpdir(), "f1-create-upstream-"));
  const upstream = join(root, "upstream");
  mkdirSync(upstream, { recursive: true });
  requireOk(upstream, ["init", "-q", "-b", "main"]);
  requireOk(upstream, ["config", "user.email", "fixture@test.local"]);
  requireOk(upstream, ["config", "user.name", "Fixture"]);
  writeFileSync(join(upstream, "README.md"), "hello\n");
  requireOk(upstream, ["add", "-A"]);
  requireOk(upstream, ["commit", "-q", "-m", "chore: init"]);
  const c0 = requireOk(upstream, ["rev-parse", "HEAD"]);
  return { root, upstream, c0 };
}

const tempRoots: string[] = [];

afterEach(() => {
  for (const d of tempRoots.splice(0))
    rmSync(d, { recursive: true, force: true });
  // Each test uses a fresh upstream (mirrors keyed by repoUrl sha never
  // collide); rows/mocks reset per test. The shared temp WORKSPACE_ROOT is
  // removed once at the end (the module captured it at import time).
  hoisted.rows.length = 0;
  vi.mocked(assertDependenciesWarm).mockClear();
  vi.mocked(runTestCmdSmoke).mockClear();
});

afterAll(() => {
  rmSync(hoisted.workspaceRoot, { recursive: true, force: true });
  delete process.env.ORCH_WORKSPACE_ROOT;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createLocalWorkspace readiness sequencing (W1→W2→W3)", () => {
  it("all three invariants pass → row ready with base_sha/ready_at/ready_report + base_ref tag; W2/W3 ran against the checkout dir", async () => {
    const f = makeUpstream();
    tempRoots.push(f.root);

    const ws = await createLocalWorkspace({
      repoUrl: f.upstream,
      ownerKind: "user",
      ownerId: "person@example.test",
      baseRef: "main",
    });

    expect(ws.dir).toBe(join(hoisted.workspaceRoot, ws.id));
    expect(existsSync(ws.dir)).toBe(true);
    // The run branch was cut from main@c0 — HEAD sits exactly at the tip (W1).
    expect(requireOk(ws.dir, ["rev-parse", "HEAD"])).toBe(f.c0);

    // Row bookkeeping: ready only after the FULL sequence, with the W1 tip as
    // base_sha and the per-stage report persisted (EvidenceCard source).
    const row = hoisted.rows[0];
    expect(row.state).toBe("ready");
    expect(row.baseSha).toBe(f.c0);
    expect(row.readyAt).toBeInstanceOf(Date);
    const report = row.readyReport as {
      w1: { ok: boolean; baseSha: string; targetBranch: string };
      w2: { ok: boolean };
      w3: { ok: boolean; testsRun: number | null };
    };
    expect(report.w1.ok).toBe(true);
    expect(report.w1.baseSha).toBe(f.c0);
    expect(report.w1.targetBranch).toBe("main");
    expect(report.w2.ok).toBe(true);
    expect(report.w3.ok).toBe(true);
    expect((row.tags as Record<string, string>).base_ref).toBe("main");

    // W2/W3 each ran once, against the workspace checkout dir.
    expect(vi.mocked(assertDependenciesWarm)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(assertDependenciesWarm).mock.calls[0][0]).toBe(ws.dir);
    expect(vi.mocked(runTestCmdSmoke)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runTestCmdSmoke).mock.calls[0][0]).toBe(ws.dir);
  });

  it("T-F1-07 注入 / T-F1-08: W3 smoke failure → row state 'failed' (not 'error'), original infra-class error propagates, dir cleaned up, W ordering held", async () => {
    const f = makeUpstream();
    tempRoots.push(f.root);

    vi.mocked(runTestCmdSmoke).mockRejectedValueOnce(
      new WorkspaceNotReadyError(
        "W3",
        "test_cmd_smoke failed (exit 1): injected",
      ),
    );

    await expect(
      createLocalWorkspace({
        repoUrl: f.upstream,
        ownerKind: "run",
        ownerId: "run-1",
        baseRef: "main",
      }),
    ).rejects.toMatchObject({
      name: "WorkspaceNotReadyError",
      stage: "W3",
      errorClass: "infra", // never recorded as an agent failure
    });

    const row = hoisted.rows[0];
    // `failed` (readiness miss) — NOT `error` (provisioning failure) and NOT
    // `ready`: no "带旧基线/坏环境 ready" ever.
    expect(row.state).toBe("failed");
    expect(row.readyAt).toBeUndefined();
    expect(row.baseSha).toBeUndefined();
    expect((row.readyReport as { error: string }).error).toContain("W3");

    // The partial checkout is cleaned up.
    const dir = join(hoisted.workspaceRoot, row.id as string);
    expect(existsSync(dir)).toBe(false);

    // Ordering: W1 (git) and W2 both ran BEFORE the failing W3.
    expect(vi.mocked(assertDependenciesWarm)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runTestCmdSmoke)).toHaveBeenCalledTimes(1);
  });

  it("W2 failure short-circuits: W3 never runs (W1→W2→W3 strict order)", async () => {
    const f = makeUpstream();
    tempRoots.push(f.root);

    vi.mocked(assertDependenciesWarm).mockRejectedValueOnce(
      new WorkspaceNotReadyError(
        "W2",
        "vitest missing after install (injected)",
      ),
    );

    await expect(
      createLocalWorkspace({
        repoUrl: f.upstream,
        ownerKind: "run",
        ownerId: "run-2",
        baseRef: "main",
      }),
    ).rejects.toMatchObject({ name: "WorkspaceNotReadyError", stage: "W2" });

    expect(hoisted.rows[0].state).toBe("failed");
    expect(vi.mocked(runTestCmdSmoke)).not.toHaveBeenCalled();
  });
});
