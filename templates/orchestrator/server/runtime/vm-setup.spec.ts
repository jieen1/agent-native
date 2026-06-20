import { describe, it, expect } from "vitest";

import { probeTools, ensureToolchain } from "./vm-setup.js";
import type {
  ExecOptions,
  ExecResult,
  NodeRuntime,
  VmHandle,
} from "./node-runtime.js";

/** Fake runtime where each `command -v` probe echoes the tools we say exist. */
function fakeRuntime(present: {
  node?: boolean;
  npm?: boolean;
  git?: boolean;
  claude?: boolean;
}): { runtime: NodeRuntime; calls: string[] } {
  const calls: string[] = [];
  const exec = async (
    _vm: VmHandle,
    cmd: string,
    _opts?: ExecOptions,
  ): Promise<ExecResult> => {
    calls.push(cmd);
    if (/command -v/.test(cmd) && /echo node/.test(cmd)) {
      // the combined probe: echo each present tool
      const lines: string[] = [];
      if (present.node) lines.push("node");
      if (present.npm) lines.push("npm");
      if (present.git) lines.push("git");
      if (present.claude) lines.push("claude");
      return { code: 0, stdout: lines.join("\n"), stderr: "" };
    }
    // apk / npm install "succeed" and flip the relevant tools present
    if (/apk add/.test(cmd)) {
      present.node = true;
      present.npm = true;
      present.git = true;
      return { code: 0, stdout: "OK", stderr: "" };
    }
    if (/npm install -g @anthropic-ai\/claude-code/.test(cmd)) {
      present.claude = true;
      return { code: 0, stdout: "added", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const runtime = { kind: "fake", exec } as unknown as NodeRuntime;
  return { runtime, calls };
}

const VM = { name: "vm", spec: { kind: "microvm", onFailure: "recreate" } } as VmHandle;

describe("probeTools", () => {
  it("reports which tools are on PATH", async () => {
    const { runtime } = fakeRuntime({ node: true, npm: true, git: true });
    const t = await probeTools(runtime, VM);
    expect(t).toEqual({ node: true, npm: true, git: true, claude: false });
  });
});

describe("ensureToolchain", () => {
  it("short-circuits (no install) when everything is already present (prebaked)", async () => {
    const { runtime, calls } = fakeRuntime({
      node: true,
      npm: true,
      git: true,
      claude: true,
    });
    const res = await ensureToolchain(runtime, VM, {
      node: true,
      git: true,
      claude: true,
    });
    expect(res.installed).toBe(false);
    expect(calls.some((c) => /apk add/.test(c))).toBe(false);
    expect(calls.some((c) => /npm install -g/.test(c))).toBe(false);
  });

  it("installs node+git+claude on a bare image, then verifies they exist", async () => {
    const { runtime, calls } = fakeRuntime({}); // nothing present
    const res = await ensureToolchain(runtime, VM, {
      node: true,
      git: true,
      claude: true,
    });
    expect(res.installed).toBe(true);
    expect(calls.some((c) => /apk add/.test(c))).toBe(true);
    expect(calls.some((c) => /npm install -g @anthropic-ai\/claude-code/.test(c))).toBe(
      true,
    );
    expect(res.after.claude).toBe(true);
  });

  it("throws clearly when a required tool is STILL missing after install", async () => {
    // npm install is a no-op here, so claude never appears → hard fail.
    const exec = async (
      _vm: VmHandle,
      cmd: string,
    ): Promise<ExecResult> => {
      if (/command -v/.test(cmd) && /echo node/.test(cmd))
        return { code: 0, stdout: "node\nnpm\ngit", stderr: "" }; // never claude
      return { code: 0, stdout: "", stderr: "" };
    };
    const runtime = { kind: "fake", exec } as unknown as NodeRuntime;
    await expect(
      ensureToolchain(runtime, VM, { node: true, git: true, claude: true }),
    ).rejects.toThrow(/still missing.*claude/s);
  });
});
