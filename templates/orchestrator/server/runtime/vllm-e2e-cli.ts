// Runnable entry for the P2b vLLM-in-VM E2E (DESIGN §7.4.1a). Boots a REAL
// microVM, runs a real agent loop against the host vLLM whose write tool acts
// inside the VM, and asserts: tool call ran, file exists IN the VM with the
// exact content, NOT on the host, tokens captured, teardown removed the VM.
//
//   npx tsx server/runtime/vllm-e2e-cli.ts
//   VLLM_E2E_MODEL=qwen3.6 npx tsx server/runtime/vllm-e2e-cli.ts
//
// Requires WSL2 + microsandbox (`msb`) AND a running vLLM at localhost:8000.
// Skips (exit 0) with a clear message if msb is not present.

import { msbAvailable } from "./wsl-msb.js";
import { runVllmE2e } from "./vllm-e2e.js";

async function main(): Promise<void> {
  if (!(await msbAvailable())) {
    // eslint-disable-next-line no-console
    console.log("SKIP: wsl/msb not available on this host — P2b E2E not run.");
    process.exit(0);
  }

  const started = Date.now();
  const result = await runVllmE2e({
    model: process.env.VLLM_E2E_MODEL,
    log: (msg) => {
      // eslint-disable-next-line no-console
      console.log(msg);
    },
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  // eslint-disable-next-line no-console
  console.log("\n=== P2b vLLM-in-VM E2E: PASS ===");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
  // eslint-disable-next-line no-console
  console.log(`(${seconds}s wall-clock)`);
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("\n=== P2b vLLM-in-VM E2E: FAIL ===");
  // eslint-disable-next-line no-console
  console.error(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exit(1);
});
