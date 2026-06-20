// The load-bearing P2b E2E (DESIGN §7.4.1a): a CODE node whose brain is the
// HOST vLLM and whose runtime is a real microVM. It proves the whole stack:
//   • PROVISION a microVM (the 7-stage NodeRunner)
//   • EXECUTE = VllmExecutor: the agent loop runs ON THE HOST against the host
//     vLLM (localhost:8000/v1); its write tool acts INSIDE the VM
//   • the model emitted ≥1 tool call (the write tool ran)
//   • the file exists IN the VM with the exact content
//   • the same path does NOT exist on the HOST (the side effect was in the VM)
//   • tokensSpent > 0 (AgentLoopUsage captured, §4.2.3)
//   • TEARDOWN removed the VM
//
// Shared by the gated vitest (`vllm-e2e.spec.ts`) and the runnable CLI
// (`vllm-e2e-cli.ts`). Throws on any failed assertion; always tears down.

import { existsSync } from "node:fs";

import { runWithRequestContext } from "@agent-native/core/server/request-context";

import { MicrosandboxRuntime } from "./microsandbox-runtime.js";
import { NodeRunner } from "./node-runner.js";
import { VllmExecutor, DEFAULT_VLLM_MODEL } from "./executors/index.js";
import { wslMsb } from "./wsl-msb.js";
import type { Node, NodeRuntimeSpec } from "../../shared/types.js";

/** The structured result of the E2E (also pretty-printed by the CLI). */
export interface VllmE2eResult {
  vmName: string;
  model: string;
  toolCallCount: number;
  tokensSpent: number;
  inVmContent: string;
  inVmContentMatches: boolean;
  existsOnHost: boolean;
  removedFromVm: boolean;
  durationMs: number;
  /** `uname -r` inside the VM (the libkrun VM kernel). */
  vmKernel: string;
  /** The WSL host kernel (the contrast). */
  hostKernel: string;
  /** True when the VM kernel differs from the host kernel (real VM boundary). */
  kernelsDiffer: boolean;
  /** `hostname` inside the VM — the VM identity, not the host. */
  vmHostname: string;
}

const HOST_WSL = process.env.ORCHESTRATOR_WSL_BIN ?? "wsl";

/** Read the WSL host kernel directly (the contrast for the VM-kernel check). */
async function wslHostKernel(): Promise<string> {
  const { spawn } = await import("node:child_process");
  return new Promise<string>((resolve, reject) => {
    const child = spawn(HOST_WSL, ["bash", "-lc", "uname -r"], {
      windowsHide: true,
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (out += c));
    child.on("error", reject);
    child.on("close", () => resolve(out.trim()));
  });
}

/** True if `name` still appears in `msb list -q` (proves teardown). */
async function inMsbList(name: string): Promise<boolean> {
  const res = await wslMsb(["list", "-q"]);
  return res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .includes(name);
}

/** The exact content the node is asked to write. */
export const E2E_MARKER = "orchestrator-p2b";
/** The in-VM path the node writes. */
export const E2E_PATH = "/work/hello.txt";

/**
 * Run the full vLLM-in-VM E2E for REAL. `opts.model` overrides the node model
 * (default the host vLLM model). Throws on any failed assertion.
 */
export async function runVllmE2e(
  opts: {
    model?: string;
    ownerEmail?: string;
    log?: (msg: string) => void;
  } = {},
): Promise<VllmE2eResult> {
  const log = opts.log ?? (() => {});
  const model = opts.model ?? DEFAULT_VLLM_MODEL;
  const ownerEmail = opts.ownerEmail ?? "e2e@localhost";

  const spec: NodeRuntimeSpec = {
    kind: "microvm",
    image: "alpine",
    onFailure: "keep",
    onSuccess: "destroy",
  };
  const node: Node = {
    id: "e2e-code",
    type: "agent",
    title: "vLLM E2E code node",
    engine: "ai-sdk:openai",
    model,
    runtime: spec,
    prompt:
      `Create the file ${E2E_PATH} containing exactly: ${E2E_MARKER}\n` +
      "Use the write tool with that exact path and content. Do not add a " +
      "trailing newline or any other text. Then stop.",
  };

  // We capture the VM name from the runner result, but we also need to inspect
  // the VM AFTER teardown is decided — so we run the NodeRunner with a probe
  // wired into a custom executor wrapper that snapshots the VM name + reads the
  // file BEFORE the runner's teardown. Simplest robust approach: provision +
  // drive the stages here is overkill; instead the executor's result carries
  // the VM name, and we set onSuccess:"keep" so we can inspect, then tear down
  // ourselves. (We override onSuccess to keep for inspection.)
  const inspectSpec: NodeRuntimeSpec = { ...spec, onSuccess: "keep" };
  const inspectNode: Node = { ...node, runtime: inspectSpec };

  const runtime = new MicrosandboxRuntime();
  const runner = new NodeRunner({
    executor: new VllmExecutor(),
    runtimeFor: () => runtime,
  });

  // The agent loop + engine resolution need a request context (§4.2 landmine 2).
  const result = await runWithRequestContext(
    { userEmail: ownerEmail, orgId: undefined },
    async () => {
      log(`[1/6] run NodeRunner (provision microVM + vLLM EXECUTE) …`);
      return runner.run(
        {
          node: inspectNode,
          deps: {},
          ownerEmail,
          orgId: null,
        },
        new AbortController().signal,
      );
    },
  );

  const vmName = result.vmName ?? "";
  if (vmName === "") throw new Error("NodeRunner returned no vmName");
  log(
    `      vm=${vmName} model=${result.model} tools=${result.toolCallCount} tokens=${result.tokensSpent}`,
  );

  // We kept the VM (onSuccess:keep) so we can inspect it; tear it down at the end.
  try {
    // (a) The model emitted a tool call.
    log(`[2/6] assert tool call emitted …`);
    if (result.toolCallCount < 1) {
      throw new Error(
        `expected ≥1 tool call (the write tool), got ${result.toolCallCount}. ` +
          `model output: ${JSON.stringify(result.output)}`,
      );
    }

    // (b) The file exists IN the VM with the exact content.
    log(`[3/6] cat ${E2E_PATH} inside the VM …`);
    const catRes = await runtime.exec(
      { name: vmName, spec: inspectSpec },
      `cat ${E2E_PATH}`,
    );
    if (catRes.code !== 0) {
      throw new Error(
        `cat ${E2E_PATH} failed in VM (code ${catRes.code}): ${catRes.stderr}`,
      );
    }
    const inVmContent = catRes.stdout.replace(/\r?\n$/, "");
    const inVmContentMatches = inVmContent === E2E_MARKER;
    log(
      `      in-VM content = ${JSON.stringify(inVmContent)} (matches=${inVmContentMatches})`,
    );
    if (!inVmContentMatches) {
      throw new Error(
        `in-VM file content ${JSON.stringify(inVmContent)} !== ` +
          `${JSON.stringify(E2E_MARKER)}`,
      );
    }

    // (c) The same path does NOT exist on the host (prove VM isolation).
    log(`[4/6] assert ${E2E_PATH} does NOT exist on the host …`);
    const existsOnHost = existsSync(E2E_PATH);
    if (existsOnHost) {
      throw new Error(
        `${E2E_PATH} exists on the HOST — the side effect leaked out of the VM`,
      );
    }

    // (c2) The bash tool's `uname`/`hostname` return the VM identity, not the
    // host: the VM kernel (libkrun) differs from the WSL host kernel.
    const hostKernel = await wslHostKernel();
    const vmKernelRes = await runtime.exec(
      { name: vmName, spec: inspectSpec },
      "uname -r",
    );
    const vmKernel = vmKernelRes.stdout.trim();
    const vmHostnameRes = await runtime.exec(
      { name: vmName, spec: inspectSpec },
      "hostname",
    );
    const vmHostname = vmHostnameRes.stdout.trim();
    const kernelsDiffer = vmKernel !== "" && vmKernel !== hostKernel;
    log(
      `      bash identity: vmKernel=${vmKernel} hostKernel=${hostKernel} ` +
        `vmHostname=${vmHostname} (differ=${kernelsDiffer})`,
    );
    if (!kernelsDiffer) {
      throw new Error(
        `VM kernel (${vmKernel}) is NOT different from host kernel ` +
          `(${hostKernel}) — bash did not act in a real microVM`,
      );
    }

    // (d) tokensSpent > 0 (AgentLoopUsage captured).
    log(`[5/6] assert tokensSpent > 0 …`);
    if (!(result.tokensSpent > 0)) {
      throw new Error(`tokensSpent was ${result.tokensSpent}; expected > 0`);
    }

    // (e) teardown removes the VM.
    log(`[6/6] teardown('destroy') + confirm gone from msb list …`);
    await runtime.teardown({ name: vmName, spec: inspectSpec }, "destroy");
    const stillThere = await inMsbList(vmName);
    const removedFromVm = !stillThere;
    if (!removedFromVm) {
      throw new Error(`VM ${vmName} still in msb list after teardown`);
    }

    return {
      vmName,
      model: result.model,
      toolCallCount: result.toolCallCount,
      tokensSpent: result.tokensSpent,
      inVmContent,
      inVmContentMatches,
      existsOnHost,
      removedFromVm,
      durationMs: result.durationMs,
      vmKernel,
      hostKernel,
      kernelsDiffer,
      vmHostname,
    };
  } catch (err: unknown) {
    // Best-effort cleanup so a failed assertion never leaks a VM.
    try {
      await runtime.teardown({ name: vmName, spec: inspectSpec }, "destroy");
    } catch {
      /* surface the original error */
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    void HOST_WSL;
  }
}
