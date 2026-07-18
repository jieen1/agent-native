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
  commitAndPush,
  bareMirrorDir,
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

// ── Unborn-HEAD incident regression (writeback-drain root cause) ───────────
//
// Root cause: ensureBareMirror's shared-mirror refresh used to fetch upstream
// with `--prune … +refs/heads/*:refs/heads/*` — mirroring the remote's branch
// set EXACTLY into the SAME `refs/heads/*` namespace where each workspace's
// own not-yet-pushed run branch also lives (created by `worktree add -B`).
// Since a run branch is by definition absent upstream until pushed, the very
// next mirror refresh (ANY other workspace being created/refreshed for the
// same repo, or a W4 diff/runSummary poll via refreshMirror) pruned it away,
// silently reverting an already-`ready` workspace's HEAD to unborn (`git log`
// → "does not have any commits yet") while its checkout's files/index stayed
// untouched — the writeback-drain incident (108+ failed retries against the
// same broken workspace). The fix keeps upstream tracking under
// `refs/remotes/origin/*` (safe to prune) disjoint from `refs/heads/*`
// (reserved for workspace-owned branches).

describe("unborn-HEAD incident regression", () => {
  it("prevention: a second workspace's mirror refresh never prunes another still-ready workspace's own run branch", async () => {
    const f = makeUpstream();
    tempRoots.push(f.root);

    const wsA = await createLocalWorkspace({
      repoUrl: f.upstream,
      ownerKind: "run",
      ownerId: "run-a",
      baseRef: "main",
    });

    // A second workspace for the SAME repo drives ensureBareMirror's
    // "existing mirror" refresh path — the exact trigger for the real
    // incident (any concurrent workspace creation, or a runSummary/diff poll
    // via refreshMirror, refreshes this SAME shared bare mirror).
    const wsB = await createLocalWorkspace({
      repoUrl: f.upstream,
      ownerKind: "run",
      ownerId: "run-b",
      baseRef: "main",
    });
    expect(wsB.dir).not.toBe(wsA.dir);

    // wsA's own branch must still be a real, non-unborn HEAD after wsB's
    // creation refreshed the shared mirror.
    expect(requireOk(wsA.dir, ["rev-parse", "--verify", "-q", "HEAD"])).toBe(
      f.c0,
    );
    const bare = bareMirrorDir(f.upstream);
    expect(
      requireOk(bare, ["rev-parse", "--verify", `refs/heads/${wsA.branch}`]),
    ).toBe(f.c0);
  });

  it("detection/self-heal: commitAndPush recreates an unborn HEAD's branch ref from the recorded base_sha before committing, preserving the staged fix", async () => {
    const f = makeUpstream();
    tempRoots.push(f.root);

    const ws = await createLocalWorkspace({
      repoUrl: f.upstream,
      ownerKind: "run",
      ownerId: "run-heal",
      baseRef: "main",
    });

    // Simulate the incident directly: delete the workspace's own branch ref
    // straight out of the shared bare mirror (what an unfixed concurrent
    // mirror refresh used to do), leaving an unborn HEAD while the checkout's
    // files/index (a real, uncommitted fix) survive untouched.
    const bare = bareMirrorDir(f.upstream);
    requireOk(bare, ["update-ref", "-d", `refs/heads/${ws.branch}`]);
    expect(() =>
      requireOk(ws.dir, ["rev-parse", "--verify", "-q", "HEAD"]),
    ).toThrow();

    writeFileSync(join(ws.dir, "fix.txt"), "the real fix\n");

    const result = await commitAndPush({
      id: ws.id,
      message: "fix: the real change",
    });

    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    expect(requireOk(ws.dir, ["rev-parse", "--verify", "-q", "HEAD"])).not.toBe(
      "",
    );

    // Decisive proof this is a real heal (branch ref recreated at base_sha),
    // not just a coincidentally-matching tree: the new commit's PARENT must
    // be f.c0. A naive `git commit` straight onto an unborn HEAD (the old,
    // unfixed behavior) instead creates a disconnected ROOT commit (zero
    // parents) — its tree would happen to diff identically against f.c0 (all
    // file content matches except the new fix.txt), which is why a bare
    // tree-diff assertion alone can't tell the two apart.
    expect(requireOk(ws.dir, ["rev-parse", "HEAD^"])).toBe(f.c0);
    expect(requireOk(ws.dir, ["rev-list", "--count", "HEAD"])).toBe("2");

    // The diff against that real base is ONLY the intended new file, never a
    // wholesale re-add of the whole repo.
    const changed = requireOk(ws.dir, [
      "diff",
      "--name-only",
      f.c0,
      "HEAD",
    ])
      .split("\n")
      .filter(Boolean);
    expect(changed).toEqual(["fix.txt"]);
  });
});

// ── Board #87: branch/baseRef collision guard ───────────────────────────────
//
// The `workspaceCreate` action's `branch` param names the NEW work branch to
// cut and check out — NOT the base branch it's cut FROM (that's `baseRef`).
// The `orchestrating-v3` skill's own doc example used to show
// `workspaceCreate({ repo, branch: baseBranch, ... })`, which passes the
// intended BASE branch's name into `branch`. Under this app's shared
// git-worktree isolation (one bare mirror + one refs/heads namespace per
// repo), that collides with ANY workspace already checked out on that branch
// name — surfacing as a raw git error ("... already used by worktree ..." /
// "refusing to fetch into branch ... checked out at ...") instead of an
// actionable one. These tests prove the fix fails FAST with a clear message
// instead — deterministically, even on the very first workspace for a repo,
// not just once a collision race actually happens.

describe("board #87 — branch must not equal the base branch it's cut from", () => {
  it("branch equal to the auto-resolved default base (no explicit baseRef) → clear actionable error, no git ever invoked", async () => {
    const f = makeUpstream();
    tempRoots.push(f.root);

    await expect(
      createLocalWorkspace({
        repoUrl: f.upstream,
        branch: "main", // the exact historical trap: branch === the repo's real base
        ownerKind: "user",
        ownerId: "person@example.test",
      }),
    ).rejects.toThrow(
      /branch \('main'\) must not equal the base branch.*\('main'\).*Pass the base via 'baseRef'/s,
    );

    // Never a raw git "already used by worktree" / "refusing to fetch" message.
    await expect(
      createLocalWorkspace({
        repoUrl: f.upstream,
        branch: "main",
        ownerKind: "user",
        ownerId: "person@example.test2",
      }),
    ).rejects.not.toThrow(/already used by worktree|refusing to fetch/);
  });

  it("branch explicitly equal to baseRef → same clear actionable error", async () => {
    const f = makeUpstream();
    tempRoots.push(f.root);

    await expect(
      createLocalWorkspace({
        repoUrl: f.upstream,
        branch: "main",
        baseRef: "main",
        ownerKind: "user",
        ownerId: "person@example.test",
      }),
    ).rejects.toThrow(/must not equal the base branch/);
  });

  it("the row is marked 'error' (provisioning failure), never left dangling as 'ready'", async () => {
    const f = makeUpstream();
    tempRoots.push(f.root);

    await expect(
      createLocalWorkspace({
        repoUrl: f.upstream,
        branch: "main",
        ownerKind: "user",
        ownerId: "person@example.test",
      }),
    ).rejects.toThrow();

    expect(hoisted.rows[0].state).toBe("error");
  });

  it("control: a DIFFERENT branch name from the same base (the correct usage) succeeds and cuts an isolated worktree", async () => {
    const f = makeUpstream();
    tempRoots.push(f.root);

    const ws = await createLocalWorkspace({
      repoUrl: f.upstream,
      branch: "feature/my-work",
      baseRef: "main",
      ownerKind: "user",
      ownerId: "person@example.test",
    });

    expect(ws.branch).toBe("feature/my-work");
    expect(existsSync(ws.dir)).toBe(true);
    expect(hoisted.rows[0].state).toBe("ready");
  });

  it("control: omitting branch entirely still defaults to a unique per-run name distinct from baseRef (never collides)", async () => {
    const f = makeUpstream();
    tempRoots.push(f.root);

    const ws = await createLocalWorkspace({
      repoUrl: f.upstream,
      baseRef: "main",
      ownerKind: "user",
      ownerId: "person@example.test",
    });

    expect(ws.branch).not.toBe("main");
    expect(ws.branch).toMatch(/^orchestrator\/run-/);
    expect(hoisted.rows[0].state).toBe("ready");
  });
});
