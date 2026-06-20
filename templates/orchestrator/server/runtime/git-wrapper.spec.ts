import { describe, it, expect } from "vitest";

import {
  runBranchName,
  checkoutRunBranch,
  commit,
  pushBranch,
  openPr,
  type GitContext,
} from "./git-wrapper.js";
import type {
  ExecOptions,
  ExecResult,
  NodeRuntime,
  VmHandle,
} from "./node-runtime.js";

/** A scriptable fake runtime for the git wrapper (exec-only). */
function fakeRuntime(
  responder: (cmd: string) => Partial<ExecResult>,
): { runtime: NodeRuntime; calls: string[] } {
  const calls: string[] = [];
  const exec = async (
    _vm: VmHandle,
    cmd: string,
    _opts?: ExecOptions,
  ): Promise<ExecResult> => {
    calls.push(cmd);
    return { code: 0, stdout: "", stderr: "", ...responder(cmd) };
  };
  const runtime = { kind: "fake", exec } as unknown as NodeRuntime;
  return { runtime, calls };
}

const VM = { name: "vm", spec: { kind: "microvm", onFailure: "recreate" } } as VmHandle;

function ctxFor(
  runtime: NodeRuntime,
  env: Record<string, string> = {},
): GitContext {
  return { runtime, vm: VM, workdir: "/work", env };
}

describe("runBranchName", () => {
  it("is deterministic and sanitizes the runId", () => {
    expect(runBranchName("run_123")).toBe("an/run-run_123");
    expect(runBranchName("a/b c")).toBe("an/run-a-b-c");
  });
});

describe("checkoutRunBranch", () => {
  it("git-inits an empty worktree, then checks out the run branch", async () => {
    const { runtime, calls } = fakeRuntime((cmd) => {
      if (/rev-parse --is-inside-work-tree/.test(cmd))
        return { code: 1, stderr: "not a git repo" };
      return { code: 0 };
    });
    const res = await checkoutRunBranch(ctxFor(runtime), {
      branch: "an/run-x",
    });
    expect(res.initialized).toBe(true);
    expect(res.branch).toBe("an/run-x");
    expect(calls.some((c) => /git init/.test(c))).toBe(true);
    expect(calls.some((c) => /checkout -B 'an\/run-x'/.test(c))).toBe(true);
  });

  it("branches from baseRef when it resolves", async () => {
    const { runtime, calls } = fakeRuntime((cmd) => {
      if (/is-inside-work-tree/.test(cmd)) return { code: 0 };
      if (/rev-parse --verify 'main'/.test(cmd)) return { code: 0 };
      return { code: 0 };
    });
    await checkoutRunBranch(ctxFor(runtime), {
      branch: "an/run-y",
      baseRef: "main",
    });
    expect(calls.some((c) => /checkout -B 'an\/run-y' 'main'/.test(c))).toBe(true);
  });
});

describe("commit", () => {
  it("reports committed:false on a clean tree (not an error)", async () => {
    const { runtime } = fakeRuntime((cmd) => {
      if (/status --porcelain/.test(cmd)) return { code: 0, stdout: "" };
      return { code: 0 };
    });
    const res = await commit(ctxFor(runtime), "msg");
    expect(res.committed).toBe(false);
    expect(res.detail).toMatch(/nothing to commit/);
  });

  it("commits and returns the sha when the tree is dirty", async () => {
    const { runtime } = fakeRuntime((cmd) => {
      if (/status --porcelain/.test(cmd)) return { code: 0, stdout: " M a.txt" };
      if (/rev-parse HEAD/.test(cmd)) return { code: 0, stdout: "deadbeef\n" };
      return { code: 0 };
    });
    const res = await commit(ctxFor(runtime), "msg");
    expect(res.committed).toBe(true);
    expect(res.sha).toBe("deadbeef");
  });
});

describe("pushBranch (push is NOT assumed to succeed, §7.1)", () => {
  it("returns no-token when GITHUB_TOKEN is absent", async () => {
    const { runtime, calls } = fakeRuntime(() => ({ code: 0 }));
    const res = await pushBranch(ctxFor(runtime), {
      branch: "an/run-x",
      remoteUrl: "https://github.com/o/r.git",
    });
    expect(res.pushed).toBe(false);
    expect(res.reason).toBe("no-token");
    // no git push was attempted without a token
    expect(calls.some((c) => /git push/.test(c))).toBe(false);
  });

  it("returns no-remote when no remote URL is provided", async () => {
    const { runtime } = fakeRuntime(() => ({ code: 0 }));
    const res = await pushBranch(ctxFor(runtime, { GITHUB_TOKEN: "tok" }), {
      branch: "an/run-x",
    });
    expect(res.pushed).toBe(false);
    expect(res.reason).toBe("no-remote");
  });

  it("classifies a non-fast-forward rejection and redacts the token", async () => {
    const { runtime } = fakeRuntime((cmd) => {
      if (/git push/.test(cmd))
        return {
          code: 1,
          stdout: "",
          stderr:
            "remote: rejected (non-fast-forward) https://x-access-token:SEKRET@github.com/o/r",
        };
      return { code: 0 };
    });
    const res = await pushBranch(ctxFor(runtime, { GITHUB_TOKEN: "SEKRET" }), {
      branch: "an/run-x",
      remoteUrl: "https://github.com/o/r.git",
    });
    expect(res.pushed).toBe(false);
    expect(res.reason).toBe("non-fast-forward");
    expect(res.detail).not.toContain("SEKRET"); // token redacted
    expect(res.detail).toContain("***");
  });

  it("injects the token into an ephemeral push URL on success", async () => {
    let pushedUrl = "";
    const { runtime } = fakeRuntime((cmd) => {
      if (/git push/.test(cmd)) {
        pushedUrl = cmd;
        return { code: 0, stdout: "done" };
      }
      return { code: 0 };
    });
    const res = await pushBranch(ctxFor(runtime, { GITHUB_TOKEN: "TOK" }), {
      branch: "an/run-x",
      remoteUrl: "https://github.com/o/r.git",
    });
    expect(res.pushed).toBe(true);
    expect(pushedUrl).toContain("x-access-token:TOK@github.com");
  });
});

describe("openPr (a PR URL exists ONLY when real, §7.1)", () => {
  it("returns no-token when GITHUB_TOKEN is absent", async () => {
    const { runtime } = fakeRuntime(() => ({ code: 0 }));
    const res = await openPr(ctxFor(runtime), {
      branch: "an/run-x",
      baseBranch: "main",
      title: "t",
    });
    expect(res.opened).toBe(false);
    expect(res.url).toBeNull();
    expect(res.reason).toBe("no-token");
  });

  it("returns no-gh when gh is not installed", async () => {
    const { runtime } = fakeRuntime((cmd) => {
      if (/command -v gh/.test(cmd)) return { code: 0, stdout: "MISSING" };
      return { code: 0 };
    });
    const res = await openPr(ctxFor(runtime, { GITHUB_TOKEN: "TOK" }), {
      branch: "an/run-x",
      baseBranch: "main",
      title: "t",
    });
    expect(res.opened).toBe(false);
    expect(res.reason).toBe("no-gh");
  });

  it("returns the real PR url when gh prints one", async () => {
    const { runtime } = fakeRuntime((cmd) => {
      if (/command -v gh/.test(cmd)) return { code: 0, stdout: "OK" };
      if (/gh pr create/.test(cmd))
        return { code: 0, stdout: "https://github.com/o/r/pull/42\n" };
      return { code: 0 };
    });
    const res = await openPr(ctxFor(runtime, { GITHUB_TOKEN: "TOK" }), {
      branch: "an/run-x",
      baseBranch: "main",
      title: "t",
    });
    expect(res.opened).toBe(true);
    expect(res.url).toBe("https://github.com/o/r/pull/42");
  });
});
