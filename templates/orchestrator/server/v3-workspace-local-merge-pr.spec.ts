// SDLC-096 merge-gate tests (2026-07-23): mergePr (server/v3-workspace-local.ts)
// had ZERO test coverage for its actual CI-gate behavior before this file —
// confirmed by an independent Codex review pass. Kept in its own file (not
// v3-workspace-local.spec.ts, which mocks only the DB layer for real-git-
// fixture tests of resolveDiffBase/refreshMirror/assertW1BaselineFresh) because
// mergePr needs `gh`/`git` (raw node:child_process.spawn) and getDbExec's
// advisory-lock transaction mocked instead.
//
// Two things locked here:
//   1. The PRE-EXISTING strict behavior: with no checkOverrides, ANY
//      non-passing/still-running check blocks the merge, exactly as before —
//      this must still be true after the SDLC-096 checkOverrides feature
//      lands, so this file's first describe block is a regression lock
//      written to characterize behavior BEFORE the feature (Codex's explicit
//      ask: "改动前先补一个锁定当前门行为的测试").
//   2. The NEW checkOverrides mechanism: a narrow, per-call, reasoned
//      exception for one NAMED, already-CONCLUDED failing check. Every other
//      failing check still blocks; a still-running check can never be
//      overridden; an override naming a check that isn't actually failing is
//      a no-op; an override with an empty reason is defensively ignored even
//      if it somehow reaches the function directly (the action-layer zod
//      schema also rejects it, but this function must not trust that alone).

import { EventEmitter } from "node:events";

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Fake `spawn` — scripts gh/git subprocess behavior by matching argv ─────

interface ScriptedResult {
  code: number;
  stdout?: string;
  stderr?: string;
}

const hoisted = vi.hoisted(() => ({
  script: new Map<string, ScriptedResult>(),
  calls: [] as string[],
  workspaceRow: null as null | {
    branch: string;
    repoUrl: string;
    hostPath: string;
    state: string;
  },
  lockGranted: true,
}));

function key(cmd: string, args: string[]): string {
  return `${cmd} ${args.join(" ")}`;
}

/** Register the result for an exact `cmd args...` invocation. */
function script(cmd: string, args: string[], result: ScriptedResult): void {
  hoisted.script.set(key(cmd, args), result);
}

vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: string[]) => {
    const k = key(cmd, args);
    hoisted.calls.push(k);
    const result = hoisted.script.get(k) ?? {
      code: 1,
      stderr: `unscripted command: ${k}`,
    };
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (result.stdout) child.stdout.emit("data", Buffer.from(result.stdout));
      if (result.stderr) child.stderr.emit("data", Buffer.from(result.stderr));
      child.emit("close", result.code);
    });
    return child;
  },
}));

vi.mock("./db/index.js", () => ({
  getV3Db: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            hoisted.workspaceRow ? [{ ...hoisted.workspaceRow }] : [],
        }),
      }),
    }),
  }),
  v3Schema: {
    v3Workspaces: {
      id: "id",
      branch: "branch",
      repoUrl: "repo_url",
      hostPath: "host_path",
      state: "state",
    },
  },
  LOCAL_DEFAULT_OWNER: "local@localhost",
  getDbExec: () => ({
    transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        execute: async () => ({
          rows: [{ locked: hoisted.lockGranted }],
        }),
      }),
  }),
}));

import { mergePr } from "./v3-workspace-local.js";

const REPO_URL = "https://github.com/acme/widgets.git";
const BRANCH = "orchestrator/run-abc123";
const PR_URL = "https://github.com/acme/widgets/pull/42";

/** Register `gh pr view` to report the given statusCheckRollup. */
function scriptPrView(rollup: Array<Record<string, unknown>>): void {
  script(
    "gh",
    [
      "pr",
      "view",
      BRANCH,
      "--json",
      "url,mergeable,mergeStateStatus,state,statusCheckRollup",
    ],
    {
      code: 0,
      stdout: JSON.stringify({
        url: PR_URL,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        state: "OPEN",
        statusCheckRollup: rollup,
      }),
    },
  );
}

/** Register a clean `gh pr merge` + post-merge `git fetch`/`rev-parse`. */
function scriptSuccessfulMerge(): void {
  script("gh", ["pr", "merge", BRANCH, "--merge", "--delete-branch=false"], {
    code: 0,
    stdout: "Merged",
  });
  script("git", ["fetch", "origin", "main"], { code: 0, stdout: "" });
  script("git", ["rev-parse", "origin/main"], {
    code: 0,
    stdout: "deadbeef1234567890\n",
  });
}

function check(
  name: string,
  status: string,
  conclusion: string | null,
): Record<string, unknown> {
  return { name, status, conclusion };
}

beforeEach(() => {
  hoisted.script.clear();
  hoisted.calls.length = 0;
  hoisted.workspaceRow = {
    branch: BRANCH,
    repoUrl: REPO_URL,
    hostPath: "/workspaces/ws-1",
    state: "ready",
  };
  hoisted.lockGranted = true;
  script("gh", ["--version"], { code: 0, stdout: "gh version 2.0.0" });
  delete process.env.GITHUB_TOKEN;
});

describe("mergePr — pre-existing strict gate (regression lock)", () => {
  it("blocks the merge when ANY check is failing, with no overrides", async () => {
    scriptPrView([
      check("Fast tests", "COMPLETED", "SUCCESS"),
      check("Security guards", "COMPLETED", "FAILURE"),
    ]);
    scriptSuccessfulMerge();

    const result = await mergePr({ id: "ws-1" });

    expect(result.merged).toBe(false);
    expect(result.reason).toMatch(/^ci_not_green: 1 check/);
    expect(result.overriddenChecks).toBeUndefined();
    expect(hoisted.calls).not.toContain(
      key("gh", ["pr", "merge", BRANCH, "--merge", "--delete-branch=false"]),
    );
  });

  it("blocks the merge when a check is still running, with no overrides", async () => {
    scriptPrView([
      check("Fast tests", "IN_PROGRESS", null),
      check("Typecheck", "COMPLETED", "SUCCESS"),
    ]);
    scriptSuccessfulMerge();

    const result = await mergePr({ id: "ws-1" });

    expect(result.merged).toBe(false);
    expect(result.reason).toMatch(/^ci_not_green: 1 check/);
  });

  it("merges cleanly when every check passes, with no overrides needed", async () => {
    scriptPrView([
      check("Fast tests", "COMPLETED", "SUCCESS"),
      check("Typecheck", "COMPLETED", "NEUTRAL"),
      check("Lint", "COMPLETED", "SKIPPED"),
    ]);
    scriptSuccessfulMerge();

    const result = await mergePr({ id: "ws-1" });

    expect(result.merged).toBe(true);
    expect(result.sha).toBe("deadbeef1234567890");
    expect(result.overriddenChecks).toBeUndefined();
  });
});

describe("mergePr — checkOverrides (SDLC-096 audited exception)", () => {
  it("lets the merge through when the only failing check has a matching, reasoned override", async () => {
    scriptPrView([
      check("Fast tests", "COMPLETED", "SUCCESS"),
      check("Security guards", "COMPLETED", "FAILURE"),
    ]);
    scriptSuccessfulMerge();

    const result = await mergePr({
      id: "ws-1",
      checkOverrides: [
        {
          checkName: "Security guards",
          reason: "pre-existing i18n/lint backlog, unrelated to this diff",
        },
      ],
    });

    expect(result.merged).toBe(true);
    expect(result.overriddenChecks).toEqual([
      {
        checkName: "Security guards",
        reason: "pre-existing i18n/lint backlog, unrelated to this diff",
      },
    ]);
  });

  it("still blocks on a check NOT covered by any override, even with other overrides present", async () => {
    scriptPrView([
      check("Fast tests", "COMPLETED", "FAILURE"),
      check("Security guards", "COMPLETED", "FAILURE"),
    ]);
    scriptSuccessfulMerge();

    const result = await mergePr({
      id: "ws-1",
      checkOverrides: [
        { checkName: "Security guards", reason: "known pre-existing backlog" },
      ],
    });

    expect(result.merged).toBe(false);
    expect(result.reason).toMatch(/^ci_not_green: 1 check/);
    // The override that DID match is still reported, for a legible audit trail
    // even on a merge that ultimately didn't go through.
    expect(result.overriddenChecks).toEqual([
      { checkName: "Security guards", reason: "known pre-existing backlog" },
    ]);
  });

  it("never overrides a check that is still running, even if named", async () => {
    scriptPrView([check("Fast tests", "IN_PROGRESS", null)]);
    scriptSuccessfulMerge();

    const result = await mergePr({
      id: "ws-1",
      checkOverrides: [
        { checkName: "Fast tests", reason: "trust me, it'll be fine" },
      ],
    });

    expect(result.merged).toBe(false);
    expect(result.reason).toMatch(/^ci_not_green: 1 check/);
  });

  it("is a no-op when the named check isn't actually failing", async () => {
    scriptPrView([check("Fast tests", "COMPLETED", "SUCCESS")]);
    scriptSuccessfulMerge();

    const result = await mergePr({
      id: "ws-1",
      checkOverrides: [
        { checkName: "Fast tests", reason: "not needed, but supplied anyway" },
      ],
    });

    expect(result.merged).toBe(true);
    // Nothing was actually overridden — the check was already passing.
    expect(result.overriddenChecks).toBeUndefined();
  });

  it("defensively ignores an override with an empty reason even if it reaches this function directly", async () => {
    scriptPrView([check("Security guards", "COMPLETED", "FAILURE")]);
    scriptSuccessfulMerge();

    const result = await mergePr({
      id: "ws-1",
      checkOverrides: [{ checkName: "Security guards", reason: "   " }],
    });

    expect(result.merged).toBe(false);
    expect(result.reason).toMatch(/^ci_not_green: 1 check/);
  });

  it("matches check names case-insensitively and with surrounding whitespace trimmed", async () => {
    scriptPrView([check("Security Guards", "COMPLETED", "FAILURE")]);
    scriptSuccessfulMerge();

    const result = await mergePr({
      id: "ws-1",
      checkOverrides: [
        { checkName: "  security guards  ", reason: "known backlog" },
      ],
    });

    expect(result.merged).toBe(true);
    expect(result.overriddenChecks).toEqual([
      { checkName: "  security guards  ", reason: "known backlog" },
    ]);
  });
});
