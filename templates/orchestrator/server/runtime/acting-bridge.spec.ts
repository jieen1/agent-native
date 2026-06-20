import { describe, it, expect } from "vitest";

import { createVmActingBridge } from "./acting-bridge.js";
import type {
  ExecOptions,
  ExecResult,
  NodeRuntime,
  RuntimeFs,
  SpawnHandle,
  TeardownPolicy,
  VmHandle,
} from "./node-runtime.js";
import type { NodeRuntimeSpec } from "../../shared/types.js";

// A pure in-memory fake NodeRuntime: `fs` is a Map, `exec` handles the few
// shell forms the bridge issues (mkdir -p, uname). This proves the acting
// bridge's CONTRACT + side-effect routing WITHOUT a real microVM (the live
// VM proof is the gated smoke/E2E).
function fakeRuntime(): {
  runtime: NodeRuntime;
  vm: VmHandle;
  files: Map<string, string>;
  execLog: string[];
} {
  const files = new Map<string, string>();
  const execLog: string[] = [];
  const spec: NodeRuntimeSpec = { kind: "microvm", onFailure: "recreate" };
  const vm: VmHandle = { name: "fake-vm", spec };

  const fs: RuntimeFs = {
    read: async (path) => {
      if (!files.has(path)) throw new Error(`no such file: ${path}`);
      return files.get(path) as string;
    },
    write: async (path, content) => {
      files.set(path, content);
    },
    copyFromHost: async () => {},
    copyToHost: async () => {},
  };

  const runtime: NodeRuntime = {
    kind: "fake",
    provision: async () => vm,
    mount: async () => {},
    init: async () => {},
    exec: async (
      _vm: VmHandle,
      cmd: string,
      _opts?: ExecOptions,
    ): Promise<ExecResult> => {
      execLog.push(cmd);
      if (cmd.startsWith("mkdir -p"))
        return { code: 0, stdout: "", stderr: "" };
      if (cmd === "uname -a") {
        return { code: 0, stdout: "Linux fake-vm 6.12.0\n", stderr: "" };
      }
      if (cmd === "false") return { code: 1, stdout: "", stderr: "boom" };
      return { code: 0, stdout: `ran: ${cmd}\n`, stderr: "" };
    },
    spawn: (): SpawnHandle => {
      throw new Error("spawn not used in this test");
    },
    fs: () => fs,
    getPortUrl: async () => {
      throw new Error("n/a");
    },
    snapshot: async () => "snap",
    teardown: async (_vm: VmHandle, _policy: TeardownPolicy) => {},
  };

  return { runtime, vm, files, execLog };
}

describe("createVmActingBridge", () => {
  it("exposes the {bash,read,edit,write} contract with the same input schemas", () => {
    const { runtime, vm } = fakeRuntime();
    const bridge = createVmActingBridge({ runtime, vm, workdir: "/work" });
    expect(Object.keys(bridge).sort()).toEqual([
      "bash",
      "edit",
      "read",
      "write",
    ]);
    // The model-visible schema must match the coding-tools shape.
    expect(bridge.bash.tool.parameters!.required).toEqual(["command"]);
    expect(bridge.write.tool.parameters!.required).toEqual([
      "filePath",
      "content",
    ]);
    expect(bridge.read.tool.parameters!.required).toEqual(["filePath"]);
    expect(bridge.edit.tool.parameters!.required).toEqual(["filePath"]);
    expect(bridge.bash.tool.parameters!.properties).toHaveProperty("command");
    expect(bridge.write.tool.parameters!.properties).toHaveProperty("content");
  });

  it("write → fs.write lands the file in the VM (relative path under workdir)", async () => {
    const { runtime, vm, files } = fakeRuntime();
    const bridge = createVmActingBridge({ runtime, vm, workdir: "/work" });
    const out = await bridge.write.run({
      filePath: "hello.txt",
      content: "orchestrator-p2b",
    });
    expect(out).toContain("Wrote /work/hello.txt");
    expect(files.get("/work/hello.txt")).toBe("orchestrator-p2b");
  });

  it("write honors absolute paths verbatim", async () => {
    const { runtime, vm, files } = fakeRuntime();
    const bridge = createVmActingBridge({ runtime, vm, workdir: "/work" });
    await bridge.write.run({ filePath: "/tmp/x.txt", content: "abs" });
    expect(files.get("/tmp/x.txt")).toBe("abs");
  });

  it("read → fs.read returns numbered lines from the VM", async () => {
    const { runtime, vm, files } = fakeRuntime();
    files.set("/work/a.txt", "one\ntwo\nthree");
    const bridge = createVmActingBridge({ runtime, vm, workdir: "/work" });
    const out = await bridge.read.run({ filePath: "a.txt" });
    expect(out).toBe("1\tone\n2\ttwo\n3\tthree");
  });

  it("edit → read + exact string-replace + write", async () => {
    const { runtime, vm, files } = fakeRuntime();
    files.set("/work/c.txt", "alpha BETA gamma");
    const bridge = createVmActingBridge({ runtime, vm, workdir: "/work" });
    const out = await bridge.edit.run({
      filePath: "c.txt",
      oldText: "BETA",
      newText: "delta",
    });
    expect(out).toContain("Edited /work/c.txt");
    expect(files.get("/work/c.txt")).toBe("alpha delta gamma");
  });

  it("edit fails (and leaves the file unchanged) on a non-unique match", async () => {
    const { runtime, vm, files } = fakeRuntime();
    files.set("/work/d.txt", "x x x");
    const bridge = createVmActingBridge({ runtime, vm, workdir: "/work" });
    const out = await bridge.edit.run({
      filePath: "d.txt",
      oldText: "x",
      newText: "y",
    });
    expect(out).toMatch(/matched more than once/);
    expect(files.get("/work/d.txt")).toBe("x x x"); // unchanged
  });

  it("bash → runtime.exec, formatting stdout + non-zero exit code", async () => {
    const { runtime, vm, execLog } = fakeRuntime();
    const bridge = createVmActingBridge({ runtime, vm, workdir: "/work" });
    const ok = await bridge.bash.run({ command: "uname -a" });
    expect(ok).toContain("Linux fake-vm");
    expect(execLog).toContain("uname -a");

    const fail = await bridge.bash.run({ command: "false" });
    expect(fail).toContain("[exit code: 1]");
    expect(fail).toContain("boom");
  });
});
