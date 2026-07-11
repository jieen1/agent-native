// F1 workspace contract — W1 (baseline freshness) / W4 (dynamic diff-base
// resolution) unit tests against REAL git fixtures (temp bare/plain repos +
// checkouts, per the storing-data/testing convention: "git 纯函数类测试
// (merge-base 逻辑)可用临时 git 仓 fixture 真实验证").
//
// Covers T-F1-01, 02, 03, 04, 05, 10, 15, 16 (see docs/sdlc-impl-f1-f4.md §6.1).
// T-F1-06/07 (W2/W3 supply pipeline) live in v3-workspace-provision.spec.ts and
// v3-workspace-local-create.spec.ts (full createLocalWorkspace flow, T-F1-08's
// failed-state semantics). T-F1-09 (dispatcher gate) lives in
// engine/v3-dispatcher.spec.ts. T-F1-11 (action-layer error propagation) lives
// in actions-diff-base-error.spec.ts. T-F1-13 (migration smoke, real Postgres)
// lives in plugins/db-migration-smoke.spec.ts. T-F1-12 (staleness event,
// reconciler tick — outside this pass's file boundary) and T-F1-14 (S7 UI,
// 本期不做) are deferred — see the deviations note in the implementation report.

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// ── Mock the DB layer (only `localWorkspaceDiff`'s row lookup needs it —
// resolveDiffBase/refreshMirror/assertW1BaselineFresh are pure-git and never
// touch getV3Db). A single mutable `hoisted.workspaceRow` lets each test seed
// exactly the row it needs. ───────────────────────────────────────────────

const hoisted = vi.hoisted(() => ({
  workspaceRow: null as null | {
    hostPath: string;
    state: string;
    repoUrl: string | null;
    tags: unknown;
  },
}));

vi.mock("./db/index.js", () => ({
  getV3Db: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            hoisted.workspaceRow ? [hoisted.workspaceRow] : [],
        }),
      }),
    }),
  }),
  v3Schema: {
    v3Workspaces: {
      id: "id",
      hostPath: "host_path",
      state: "state",
      repoUrl: "repo_url",
      tags: "tags",
    },
  },
  LOCAL_DEFAULT_OWNER: "local@localhost",
}));

import {
  resolveDiffBase,
  refreshMirror,
  assertW1BaselineFresh,
  localWorkspaceDiff,
  DiffBaseUnresolvableError,
} from "./v3-workspace-local.js";

// ── Git fixture helpers (real subprocess git — no mocking) ──────────────────

function git(
  cwd: string,
  args: string[],
): { code: number; stdout: string; stderr: string } {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.error) throw res.error;
  return {
    code: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function requireOk(cwd: string, args: string[]): string {
  const res = git(cwd, args);
  if (res.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${res.stderr || res.stdout}`,
    );
  }
  return res.stdout.trim();
}

/** Create a plain (non-bare) repo at `dir` with `main` as the initial branch. */
function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  requireOk(dir, ["init", "-q", "-b", "main"]);
  requireOk(dir, ["config", "user.email", "fixture@test.local"]);
  requireOk(dir, ["config", "user.name", "Fixture"]);
}

/** Write `file` with `content`, commit it, and return the new commit sha. */
function commitFile(
  dir: string,
  file: string,
  content: string,
  message: string,
): string {
  writeFileSync(join(dir, file), content);
  requireOk(dir, ["add", "-A"]);
  requireOk(dir, ["commit", "-q", "-m", message]);
  return requireOk(dir, ["rev-parse", "HEAD"]);
}

interface Fixture {
  root: string;
  /** A plain repo standing in for the real upstream remote. */
  upstream: string;
  /** A bare clone of `upstream` standing in for the shared bare mirror. */
  mirror: string;
  /** A clone of `mirror` standing in for the workspace checkout. */
  dir: string;
  /** The initial commit sha (both `upstream` and `mirror`/`dir` start here). */
  c0: string;
}

/** upstream (plain, commit c0 on main) → mirror (bare clone) → dir (clone of mirror, on main@c0). */
function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "f1-diffbase-"));
  const upstream = join(root, "upstream");
  const mirror = join(root, "mirror");
  const dir = join(root, "work");

  initRepo(upstream);
  const c0 = commitFile(upstream, "README.md", "hello\n", "chore: init");

  requireOk(root, ["clone", "-q", "--bare", upstream, mirror]);
  requireOk(root, ["clone", "-q", mirror, dir]);
  requireOk(dir, ["config", "user.email", "fixture@test.local"]);
  requireOk(dir, ["config", "user.name", "Fixture"]);

  return { root, upstream, mirror, dir, c0 };
}

const tempDirs: string[] = [];
function track(f: Fixture): Fixture {
  tempDirs.push(f.root);
  return f;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
  delete process.env.GIT_TIMEOUT_MS;
  delete process.env.ORCH_WORKSPACE_ISOLATION;
  hoisted.workspaceRow = null;
});

// ── T-F1-01: resolveDiffBase normal path ────────────────────────────────────

describe("resolveDiffBase", () => {
  it("T-F1-01: resolves the real merge-base against the target branch", async () => {
    const f = track(makeFixture());
    requireOk(f.dir, ["checkout", "-q", "-b", "feature"]);
    commitFile(f.dir, "a.txt", "1\n", "feat: a");
    commitFile(f.dir, "b.txt", "2\n", "feat: b");

    const result = await resolveDiffBase(f.dir, f.mirror, "main");

    expect(result.base).toBe(f.c0);
    expect(result.baseSource).toBe("merge-base(origin/main, HEAD)");
  });

  it("T-F1-02: throws DiffBaseUnresolvableError when the target branch doesn't exist upstream", async () => {
    const f = track(makeFixture());
    requireOk(f.dir, ["checkout", "-q", "-b", "feature"]);
    commitFile(f.dir, "a.txt", "1\n", "feat: a");

    // Deleting only dir's local refs/remotes/origin/main would be insufficient
    // (a fresh fetch self-heals it) — the branch must be genuinely absent from
    // the mirror/upstream, which it already is (never created).
    await expect(
      resolveDiffBase(f.dir, f.mirror, "does-not-exist-anywhere"),
    ).rejects.toBeInstanceOf(DiffBaseUnresolvableError);
  });

  it("T-F1-03: throws DiffBaseUnresolvableError on an orphan branch (no common ancestor)", async () => {
    const f = track(makeFixture());
    requireOk(f.dir, ["checkout", "-q", "--orphan", "orphan"]);
    requireOk(f.dir, ["rm", "-r", "-f", "-q", "."]);
    commitFile(f.dir, "orphan.txt", "orphan\n", "chore: unrelated history");

    await expect(
      resolveDiffBase(f.dir, f.mirror, "main"),
    ).rejects.toBeInstanceOf(DiffBaseUnresolvableError);
  });

  it("T-F1-04: refreshMirror is called AT CALL TIME — base reflects the latest tip, never a cached one", async () => {
    const f = track(makeFixture());
    // dir's "feature" branch is cut at c0, matching main.
    requireOk(f.dir, ["checkout", "-q", "-b", "feature"]);

    // Upstream advances past c0 to c1 — the mirror does NOT know about this yet.
    const c1 = commitFile(
      f.upstream,
      "up.txt",
      "v2\n",
      "chore: advance upstream",
    );

    // dir catches up to c1 via a side channel (simulating a workspace whose
    // branch already contains a commit the (still-stale) mirror hasn't seen) —
    // this is what makes the merge-base VALUE itself discriminate stale vs
    // fresh: merge-base(stale mirror @ c0, dir @ c1) would wrongly be c0;
    // merge-base(freshly-refreshed mirror @ c1, dir @ c1) is correctly c1.
    requireOk(f.dir, ["fetch", "-q", f.upstream, "main"]);
    requireOk(f.dir, ["reset", "-q", "--hard", "FETCH_HEAD"]);

    // Deliberately do NOT fetch `mirror` manually — only resolveDiffBase's
    // internal refreshMirror() call may bring it up to date.
    const result = await resolveDiffBase(f.dir, f.mirror, "main");

    expect(result.base).toBe(c1);
  });

  it("T-F1-15: an explicit `against` resolves directly, baseSource='explicit', no merge-base/refreshMirror path taken", async () => {
    const f = track(makeFixture());
    requireOk(f.dir, ["checkout", "-q", "-b", "feature"]);
    const featureCommit = commitFile(f.dir, "a.txt", "1\n", "feat: a");

    hoisted.workspaceRow = {
      hostPath: f.dir,
      state: "ready",
      // Deliberately a repoUrl with NO mirror at that path — if the code
      // incorrectly fell through to the dynamic resolveDiffBase branch (which
      // needs a real bare mirror), it would throw. Passing `against` explicit
      // must short-circuit before ever needing repoUrl/mirror at all.
      repoUrl: "file:///nonexistent/mirror/for/this/test",
      tags: {},
    };

    const result = await localWorkspaceDiff("ws-explicit", featureCommit);

    expect(result).not.toBeNull();
    expect(result!.base).toBe(featureCommit);
    expect(result!.baseSource).toBe("explicit");
  });

  it("T-F1-10: B4 regression replay — diff file count/stats match real `git diff --stat` ground truth", async () => {
    const f = track(makeFixture());
    // Clone isolation for this test: the workspace's own `origin` (the fixture
    // mirror) is the W4 fetch source, so no bareMirrorDir(repoUrl) path (which
    // would point under the real WORKSPACE_ROOT) is needed. The dynamic
    // resolveDiffBase branch is still fully exercised (fetch + merge-base).
    process.env.ORCH_WORKSPACE_ISOLATION = "clone";
    requireOk(f.dir, ["checkout", "-q", "-b", "feature"]);

    const files = [
      "one.txt",
      "two.txt",
      "three.txt",
      "four.txt",
      "five.txt",
      "six.txt",
      "seven.txt",
    ];
    for (const file of files) {
      writeFileSync(join(f.dir, file), `content of ${file}\nline2\n`);
    }
    requireOk(f.dir, ["add", "-A"]);
    requireOk(f.dir, ["commit", "-q", "-m", "feat: touch 7 files"]);

    hoisted.workspaceRow = {
      hostPath: f.dir,
      state: "ready",
      repoUrl: f.upstream,
      tags: { base_ref: "main" },
    };

    const result = await localWorkspaceDiff("ws-b4");
    expect(result).not.toBeNull();

    // Ground truth: real `git diff --stat` against the SAME resolved base.
    const groundTruthNumstat = requireOk(f.dir, [
      "--no-pager",
      "diff",
      "--numstat",
      result!.base,
    ]);
    const groundTruthFileCount = groundTruthNumstat
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean).length;

    expect(groundTruthFileCount).toBe(7);
    expect(result!.files.length).toBe(7);
    expect(new Set(result!.files.map((f2) => f2.path))).toEqual(new Set(files));
    for (const f2 of result!.files) {
      expect(f2.additions).toBe(2); // 2 lines added per new file
      expect(f2.deletions).toBe(0);
      expect(f2.status).toBe("A");
    }
  });
});

// ── T-F1-05: W1 baseline-freshness assertion ────────────────────────────────

describe("assertW1BaselineFresh (W1)", () => {
  it("T-F1-05: fresh at creation passes with no reset; stale after mirror advances is fast-forwarded and re-verified", async () => {
    const f = track(makeFixture());
    // Workspace's run branch cut fresh from main@c0 — matches "just provisioned".
    requireOk(f.dir, ["checkout", "-q", "-b", "run-branch"]);

    const firstPass = await assertW1BaselineFresh(f.dir, f.mirror, "main");
    expect(firstPass.resetPerformed).toBe(false);
    expect(firstPass.baseSha).toBe(f.c0);

    // The target branch advances AFTER the workspace was cut (createWorkspace
    // → run start race — SDLC-056).
    const c1 = commitFile(
      f.upstream,
      "later.txt",
      "v2\n",
      "chore: main advances",
    );

    const secondPass = await assertW1BaselineFresh(f.dir, f.mirror, "main");
    expect(secondPass.resetPerformed).toBe(true);
    expect(secondPass.baseSha).toBe(c1);

    // The workspace's HEAD was actually fast-forwarded to the fresh tip.
    expect(requireOk(f.dir, ["rev-parse", "HEAD"])).toBe(c1);

    // Merge-base distance is now genuinely 0.
    const mb = requireOk(f.dir, [
      "merge-base",
      "refs/remotes/origin/main",
      "HEAD",
    ]);
    expect(mb).toBe(c1);
  });

  it("throws WorkspaceNotReadyError('W1') when the target branch cannot be resolved", async () => {
    const f = track(makeFixture());
    requireOk(f.dir, ["checkout", "-q", "-b", "run-branch"]);

    await expect(
      assertW1BaselineFresh(f.dir, f.mirror, "no-such-branch"),
    ).rejects.toMatchObject({
      name: "WorkspaceNotReadyError",
      stage: "W1",
      errorClass: "infra",
    });
  });
});

// ── T-F1-16: refreshMirror timeout bound ────────────────────────────────────

describe("refreshMirror", () => {
  it("T-F1-16: a tiny GIT_TIMEOUT_MS bounds an unreachable remote — fails fast, never hangs", async () => {
    const f = track(makeFixture());
    // Point the mirror's origin at a non-routable address so the connect
    // attempt would otherwise hang on the OS's own (much longer) TCP timeout.
    requireOk(f.mirror, [
      "remote",
      "set-url",
      "origin",
      "http://10.255.255.1/unreachable.git",
    ]);

    process.env.GIT_TIMEOUT_MS = "300";

    const startedAt = Date.now();
    await expect(refreshMirror(f.mirror)).rejects.toThrow();
    const elapsedMs = Date.now() - startedAt;

    // Bounded well under a real OS TCP timeout (which can run 30s+) — proves
    // GIT_TIMEOUT_MS is actually enforced, not just documented.
    expect(elapsedMs).toBeLessThan(10_000);
  });
});
