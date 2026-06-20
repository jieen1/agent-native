import { describe, it, expect } from "vitest";

// GATED real vLLM-in-VM E2E (DESIGN §7.4.1a). This boots a real libkrun microVM
// AND drives a real agent loop against the host vLLM, so it is OFF by default
// (slow + needs KVM + a running vLLM at localhost:8000). Enable with
// RUN_VLLM_E2E=1. The runnable proof is `vllm-e2e-cli.ts`.
//
// `vllm-e2e.js` pulls in the full core agent stack (runAgentLoop + engines +
// OpenTelemetry), which vitest's collection-time ESM transform cannot resolve.
// So we import it LAZILY inside the (gated) test body — when disabled, the
// suite collects with zero heavy imports and the default `pnpm test` stays fast.
const enabled = process.env.RUN_VLLM_E2E === "1";

describe.skipIf(!enabled)("VllmExecutor real vLLM-in-VM E2E", () => {
  it("vLLM agent loop writes a file INSIDE the microVM, not the host", async () => {
    const { msbAvailable } = await import("./wsl-msb.js");
    const { runVllmE2e, E2E_MARKER } = await import("./vllm-e2e.js");
    if (!(await msbAvailable())) {
      throw new Error("RUN_VLLM_E2E=1 set but wsl/msb is not available");
    }
    const r = await runVllmE2e({ model: process.env.VLLM_E2E_MODEL });
    expect(r.toolCallCount).toBeGreaterThanOrEqual(1); // (a) tool call ran
    expect(r.inVmContent).toBe(E2E_MARKER); // (b) file in VM, exact content
    expect(r.inVmContentMatches).toBe(true);
    expect(r.existsOnHost).toBe(false); // (c) NOT on host
    expect(r.kernelsDiffer).toBe(true); // (c2) bash acts in VM (kernel differs)
    expect(r.vmKernel).not.toBe(r.hostKernel);
    expect(r.tokensSpent).toBeGreaterThan(0); // (d) usage captured
    expect(r.removedFromVm).toBe(true); // (e) teardown removed VM
  }, 300_000);
});
