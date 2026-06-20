// Runnable entry for the P2a microVM smoke proof (DESIGN §7.4.2). Boots a REAL
// alpine microVM via `wsl msb`, proves provision/exec/fs-roundtrip/teardown,
// and exits non-zero on any failed assertion.
//
//   pnpm --filter orchestrator exec tsx server/runtime/smoke-cli.ts
//   (or)  npx tsx server/runtime/smoke-cli.ts
//
// Requires WSL2 + microsandbox (`msb`) on the host. Skips (exit 0) with a clear
// message if msb is not present, so CI on a non-KVM box does not fail.

import { msbAvailable } from "./wsl-msb.js";
import { runSmoke } from "./smoke.js";

async function main(): Promise<void> {
  if (!(await msbAvailable())) {
    // eslint-disable-next-line no-console
    console.log(
      "SKIP: wsl/msb not available on this host — P2a smoke not run.",
    );
    process.exit(0);
  }

  const started = Date.now();
  const result = await runSmoke((msg) => {
    // eslint-disable-next-line no-console
    console.log(msg);
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  // eslint-disable-next-line no-console
  console.log("\n=== P2a microVM smoke: PASS ===");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
  // eslint-disable-next-line no-console
  console.log(`(${seconds}s wall-clock)`);
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("\n=== P2a microVM smoke: FAIL ===");
  // eslint-disable-next-line no-console
  console.error(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exit(1);
});
