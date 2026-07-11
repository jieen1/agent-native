// F1 workspace contract — T-F1-11: DiffBaseUnresolvableError propagation to
// BOTH resolveDiffBase call sites (docs/sdlc-impl-f1-f4.md §6.1): the
// `workspaceDiff` action and `runSummary`'s diff stats. 观测错=守门错 — each
// caller must return `{ error: "diff-base-unresolvable", detail }` with NO
// diff statistics, never a "looks like a diff" answer computed against a
// guessed base. Also locks the T-F1-10 return-body half (base + baseSource
// present on success).
//
// Lives under server/ (the vitest include root); the actions are imported
// across the boundary with their framework/db/runtime deps mocked at the
// module seams. The DiffBaseUnresolvableError class stays REAL (unmocked
// provision module) so the instanceof check inside each action is the same
// one production takes.

import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  /** FIFO of result arrays; each awaited db query pops one. */
  queue: [] as unknown[][],
}));

// ── Framework seams ──────────────────────────────────────────────────────────

vi.mock("@agent-native/core", () => ({
  // Identity: the action module's `defineAction({...})` returns its config so
  // the test can call `.run(args)` directly.
  defineAction: (cfg: unknown) => cfg,
}));

vi.mock("@agent-native/core/server", () => ({
  resolveSecret: async () => null,
}));

// ── Runtime seams (imported by actions/v3-workspace.ts; unused on the
// host-native paths under test, mocked so importing the module is cheap). ───

vi.mock("./runtime/microsandbox-runtime.js", () => ({
  MicrosandboxRuntime: class {},
}));
vi.mock("./runtime/git-wrapper.js", () => ({
  addAll: vi.fn(),
  commit: vi.fn(),
  pushBranch: vi.fn(),
}));
vi.mock("./runtime/vm-creds.js", () => ({
  VM_HOME: "/home/sandbox",
  scrubSecretsFromLog: (s: string) => s,
}));

// ── The W4 seam: local diff/stats throw the REAL error class. ───────────────

vi.mock("./v3-workspace-local.js", () => ({
  createLocalWorkspace: vi.fn(),
  localWorkspaceDiff: vi.fn(),
  localWorkspaceFiles: vi.fn(),
  localWorkspaceRead: vi.fn(),
  commitAndPush: vi.fn(),
  localWorkspaceDiffStats: vi.fn(),
}));

// ── DB seam: a queue-driven awaitable query builder. Real drizzle column
// objects (v3-schema) keep eq/and/or/inArray/isNotNull construction real;
// `getSQL` makes the builder a valid SQLWrapper for the owner-scope subquery.
vi.mock("./db/index.js", async () => {
  const { sql } = await import("drizzle-orm");
  const v3Schema = await import("./db/v3-schema.js");
  const subquerySql = sql`(select 1)`;

  function makeBuilder(): Record<string, unknown> {
    const api: Record<string, unknown> = {};
    for (const m of [
      "from",
      "where",
      "limit",
      "offset",
      "orderBy",
      "groupBy",
      "innerJoin",
      "leftJoin",
    ]) {
      api[m] = () => api;
    }
    api.getSQL = () => subquerySql;
    api.then = (
      resolve: (rows: unknown[]) => void,
      _reject: (err: unknown) => void,
    ) => resolve(hoisted.queue.shift() ?? []);
    return api;
  }

  return {
    getV3Db: () => ({
      select: () => makeBuilder(),
      insert: () => ({ values: async () => ({}) }),
      update: () => ({ set: () => ({ where: async () => ({}) }) }),
    }),
    v3Schema,
    resolveOwnerEmail: () => "local@localhost",
    LOCAL_DEFAULT_OWNER: "local@localhost",
    getDb: () => ({}),
    getDbExec: () => ({}),
    schema: {},
  };
});

import { workspaceDiff } from "../actions/v3-workspace.js";
import { runSummary } from "../actions/v3-run-summary.js";
import {
  localWorkspaceDiff,
  localWorkspaceDiffStats,
} from "./v3-workspace-local.js";
import { DiffBaseUnresolvableError } from "./v3-workspace-provision.js";

// The identity defineAction mock returns the raw config; type it loosely.
const workspaceDiffRun = (
  workspaceDiff as unknown as { run: (a: unknown) => Promise<any> }
).run;
const runSummaryRun = (
  runSummary as unknown as { run: (a: unknown) => Promise<any> }
).run;

/** A ready host-native workspace row (vm_name NULL → the local diff path). */
const HOST_NATIVE_WS = {
  id: "ws-1",
  ownerKind: "run",
  ownerId: "run-1",
  tags: {},
  vmName: null,
  repoUrl: "https://example.test/repo.git",
  branch: "orchestrator/run-1",
  state: "ready",
  createdAt: null,
  destroyedAt: null,
  createdBy: "run:run-1",
};

beforeEach(() => {
  hoisted.queue.length = 0;
  vi.mocked(localWorkspaceDiff).mockReset();
  vi.mocked(localWorkspaceDiffStats).mockReset();
});

describe("T-F1-11: workspaceDiff action (caller 1)", () => {
  it("returns {error:'diff-base-unresolvable', detail} with ZERO diff statistics on DiffBaseUnresolvableError", async () => {
    hoisted.queue.push([HOST_NATIVE_WS]); // assertWorkspaceExists
    vi.mocked(localWorkspaceDiff).mockRejectedValue(
      new DiffBaseUnresolvableError(
        "/ws/dir",
        "main",
        "no common ancestor (injected)",
      ),
    );

    const res = await workspaceDiffRun({ workspaceId: "ws-1" });

    expect(res.error).toBe("diff-base-unresolvable");
    expect(res.detail).toContain("main");
    // NO diff statistics of any kind — not even empty placeholders.
    expect(res).not.toHaveProperty("files");
    expect(res).not.toHaveProperty("diff");
    expect(res).not.toHaveProperty("base");
  });

  it("success path returns base + baseSource in the body (T-F1-10 return-body half)", async () => {
    hoisted.queue.push([HOST_NATIVE_WS]);
    vi.mocked(localWorkspaceDiff).mockResolvedValue({
      diff: "diff --git a/x b/x\n",
      files: [
        { path: "x", additions: 1, deletions: 0, status: "M", patch: "" },
      ],
      base: "abc123def",
      baseSource: "merge-base(origin/main, HEAD)",
    });

    const res = await workspaceDiffRun({ workspaceId: "ws-1" });

    expect(res.base).toBe("abc123def");
    expect(res.baseSource).toBe("merge-base(origin/main, HEAD)");
    expect(res.files).toHaveLength(1);
    expect(res).not.toHaveProperty("error");
  });

  it("a non-W4 error still throws (only DiffBaseUnresolvableError is translated)", async () => {
    hoisted.queue.push([HOST_NATIVE_WS]);
    vi.mocked(localWorkspaceDiff).mockRejectedValue(new Error("disk exploded"));

    await expect(workspaceDiffRun({ workspaceId: "ws-1" })).rejects.toThrow(
      "disk exploded",
    );
  });
});

describe("T-F1-11: runSummary diff stats (caller 2)", () => {
  function queueRunSummaryReads(withWorkspaceSpawn: boolean): void {
    hoisted.queue.push(
      // 1. run row
      [
        {
          id: "run-1",
          templateId: null,
          templateVersion: null,
          status: "done",
          priority: 0,
          tags: null,
          dagVersion: 1,
          startedAt: null,
          completedAt: null,
        },
      ],
      // 2. node status counts
      [],
      // 3. terminal nodes
      [],
      // 4. token aggregate
      [{ totalInput: 0, totalOutput: 0, spawnCount: 0 }],
      // 5. latest spawn carrying a workspaceId
      withWorkspaceSpawn ? [{ workspaceId: "ws-9" }] : [],
    );
  }

  it("returns diff:{error:'diff-base-unresolvable', detail} — never stats from a guessed base", async () => {
    queueRunSummaryReads(true);
    vi.mocked(localWorkspaceDiffStats).mockRejectedValue(
      new DiffBaseUnresolvableError(
        "/ws/9",
        "main",
        "target branch unfetchable (injected)",
      ),
    );

    const res = await runSummaryRun({ runId: "run-1" });

    expect(res.diff).toMatchObject({ error: "diff-base-unresolvable" });
    expect(res.diff.detail).toContain("main");
    expect(res.diff).not.toHaveProperty("filesChanged");
    expect(res.diff).not.toHaveProperty("base");
  });

  it("success path returns aggregate stats with base + baseSource", async () => {
    queueRunSummaryReads(true);
    vi.mocked(localWorkspaceDiffStats).mockResolvedValue({
      base: "abc123def",
      baseSource: "merge-base(origin/main, HEAD)",
      filesChanged: 7,
      additions: 14,
      deletions: 0,
    });

    const res = await runSummaryRun({ runId: "run-1" });

    expect(res.diff).toEqual({
      base: "abc123def",
      baseSource: "merge-base(origin/main, HEAD)",
      filesChanged: 7,
      additions: 14,
      deletions: 0,
    });
  });

  it("no spawn with a workspace → diff is null (no diff surface fabricated)", async () => {
    queueRunSummaryReads(false);

    const res = await runSummaryRun({ runId: "run-1" });

    expect(res.diff).toBeNull();
    expect(vi.mocked(localWorkspaceDiffStats)).not.toHaveBeenCalled();
  });
});
