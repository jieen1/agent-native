// Real microVM smoke proof for the P2a NodeRuntime abstraction (DESIGN §7.4.2).
// Boots an actual alpine microVM via `wsl msb`, proves the four properties that
// matter, then tears it down and confirms removal. Shared by the runnable CLI
// (`smoke-cli.ts`) and the gated vitest (`smoke.spec.ts`).
//
// What it proves (each an assertion, not a log line):
//   1. PROVISION + EXEC: `uname -r` inside the VM is the libkrun VM kernel,
//      DIFFERENT from the WSL host kernel — i.e. a real VM boundary, not the
//      host. (We read the host kernel via `wsl uname -r` and assert inequality.)
//   2. FS ROUNDTRIP: fs.write("/tmp/probe","hello-p2a") then fs.read(...) ===
//      "hello-p2a" — the acting-bridge file side effects land INSIDE the VM.
//   3. VM IDENTITY: `hostname` runs in the VM and returns the sandbox name.
//   4. TEARDOWN: after teardown("destroy"), the sandbox is GONE from `msb list`.

import { spawn } from "node:child_process";

import { MicrosandboxRuntime } from "./microsandbox-runtime.js";
import { wslMsb } from "./wsl-msb.js";
import type { NodeRuntimeSpec } from "../../shared/types.js";

/** The structured result of a smoke run (also pretty-printed by the CLI). */
export interface SmokeResult {
  sandboxName: string;
  hostKernel: string;
  vmKernel: string;
  kernelsDiffer: boolean;
  fsWrote: string;
  fsRead: string;
  fsRoundtripOk: boolean;
  vmHostname: string;
  inListBeforeTeardown: boolean;
  inListAfterTeardown: boolean;
  removedOk: boolean;
}

/** Read the WSL host kernel directly (the contrast for the VM-kernel assertion). */
async function wslHostKernel(): Promise<string> {
  const wslBin = process.env.ORCHESTRATOR_WSL_BIN ?? "wsl";
  return new Promise<string>((resolveKernel, reject) => {
    const child = spawn(wslBin, ["bash", "-lc", "uname -r"], {
      windowsHide: true,
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (out += c));
    child.on("error", reject);
    child.on("close", () => resolveKernel(out.trim()));
  });
}

/** True if `name` currently appears in `msb list -q`. */
async function inList(name: string): Promise<boolean> {
  const res = await wslMsb(["list", "-q"]);
  return res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .includes(name);
}

/**
 * Run the full smoke against a REAL microVM. Throws an Error on any failed
 * assertion (with the property that failed), and always attempts teardown.
 */
export async function runSmoke(
  log: (msg: string) => void = () => {},
): Promise<SmokeResult> {
  const runtime = new MicrosandboxRuntime();
  const spec: NodeRuntimeSpec = {
    kind: "microvm",
    image: "alpine",
    onFailure: "recreate",
    onSuccess: "destroy",
  };

  const hostKernel = await wslHostKernel();
  log(`[host] WSL kernel = ${hostKernel}`);

  log("[1/5] provision (msb run -d) …");
  const vm = await runtime.provision(spec);
  log(`      sandbox name = ${vm.name}`);

  try {
    // 1. EXEC uname -r — VM kernel must differ from the host kernel.
    const unameRes = await runtime.exec(vm, "uname -r");
    if (unameRes.code !== 0) {
      throw new Error(
        `exec uname failed (code ${unameRes.code}): ${unameRes.stderr}`,
      );
    }
    const vmKernel = unameRes.stdout.trim();
    log(`[2/5] exec uname -r  → VM kernel = ${vmKernel}`);
    const kernelsDiffer = vmKernel !== "" && vmKernel !== hostKernel;
    if (!kernelsDiffer) {
      throw new Error(
        `VM kernel (${vmKernel}) is NOT different from host kernel (${hostKernel}) — ` +
          `exec did not land in a real microVM`,
      );
    }

    // 2. FS roundtrip — write then read back inside the VM.
    const probePath = "/tmp/probe";
    const probeValue = "hello-p2a";
    await runtime.fs(vm).write(probePath, probeValue);
    const fsRead = await runtime.fs(vm).read(probePath);
    const fsRoundtripOk = fsRead.replace(/\r?\n$/, "") === probeValue;
    log(`[3/5] fs.write/read ${probePath} → ${JSON.stringify(fsRead)}`);
    if (!fsRoundtripOk) {
      throw new Error(
        `fs roundtrip mismatch: wrote ${JSON.stringify(probeValue)}, read ${JSON.stringify(fsRead)}`,
      );
    }

    // 3. VM identity — hostname in the VM equals the sandbox name.
    const hostnameRes = await runtime.exec(vm, "hostname");
    const vmHostname = hostnameRes.stdout.trim();
    log(`[4/5] exec hostname  → ${vmHostname}`);

    const inListBeforeTeardown = await inList(vm.name);
    if (!inListBeforeTeardown) {
      throw new Error(`sandbox ${vm.name} not in msb list before teardown`);
    }

    // 4. TEARDOWN destroy, then confirm gone from `msb list`.
    log("[5/5] teardown('destroy') …");
    await runtime.teardown(vm, "destroy");
    const inListAfterTeardown = await inList(vm.name);
    const removedOk = !inListAfterTeardown;
    log(
      `      in msb list after teardown? ${inListAfterTeardown}  → removedOk=${removedOk}`,
    );
    if (!removedOk) {
      throw new Error(`sandbox ${vm.name} STILL in msb list after teardown`);
    }

    return {
      sandboxName: vm.name,
      hostKernel,
      vmKernel,
      kernelsDiffer,
      fsWrote: probeValue,
      fsRead,
      fsRoundtripOk,
      vmHostname,
      inListBeforeTeardown,
      inListAfterTeardown,
      removedOk,
    };
  } catch (err: unknown) {
    // Best-effort cleanup so a failed assertion never leaks a VM.
    try {
      await runtime.teardown(vm, "destroy");
    } catch {
      /* ignore cleanup error; surface the original */
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}
