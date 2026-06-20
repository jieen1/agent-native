import { describe, it, expect } from "vitest";

import { msbAvailable } from "./wsl-msb.js";
import { runSmoke } from "./smoke.js";

// GATED real-microVM smoke (DESIGN §7.4.2). This boots an actual libkrun
// microVM via `wsl msb` (~10–30 s), so it is OFF by default — the normal
// `pnpm test` run must stay fast/deterministic and never require KVM. Enable
// with RUN_MICROVM_SMOKE=1 (and msb present). The runnable proof is
// `smoke-cli.ts`; this spec exists so the smoke can also run inside vitest.
const enabled = process.env.RUN_MICROVM_SMOKE === "1";

describe.skipIf(!enabled)("MicrosandboxRuntime real microVM smoke", () => {
  it("provision → exec(uname is VM kernel) → fs roundtrip → teardown removes it", async () => {
    if (!(await msbAvailable())) {
      // Asked to run but msb is missing — make that explicit, don't silently pass.
      throw new Error("RUN_MICROVM_SMOKE=1 set but wsl/msb is not available");
    }
    const r = await runSmoke();
    expect(r.kernelsDiffer).toBe(true);
    expect(r.vmKernel).not.toBe(r.hostKernel);
    expect(r.fsRoundtripOk).toBe(true);
    expect(r.fsRead.replace(/\r?\n$/, "")).toBe("hello-p2a");
    expect(r.inListBeforeTeardown).toBe(true);
    expect(r.removedOk).toBe(true);
    expect(r.inListAfterTeardown).toBe(false);
  }, 180_000);
});
