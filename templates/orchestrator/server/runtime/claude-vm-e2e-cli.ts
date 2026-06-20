// Runnable entry for the P2c claude-in-VM E2E (DESIGN §7.4.1a / §7.0). Boots a
// REAL microVM, fixes its DNS for direct public egress, copies the host
// `~/.claude` into the disposable VM (host copy untouched), installs the `claude`
// CLI via egress, runs the REAL
// `claude --output-format stream-json -p …` IN the VM, and asserts: a real reply
// came back from the API, tokens > 0, the subscription mounted, the per-run
// branch was cut. Then proves the git wrapper (branch+commit succeed; push fails
// clearly without a token).
//
//   npx tsx server/runtime/claude-vm-e2e-cli.ts
//
// Requires WSL2 + microsandbox (`msb`) + a real `~/.claude` login on the host.
// Skips (exit 0) with a clear message if msb is not present.

import { msbAvailable } from "./wsl-msb.js";
import { runClaudeVmE2e, runGitWrapperE2e } from "./claude-vm-e2e.js";

async function main(): Promise<void> {
  if (!(await msbAvailable())) {
    // eslint-disable-next-line no-console
    console.log("SKIP: wsl/msb not available on this host — P2c E2E not run.");
    process.exit(0);
  }

  const started = Date.now();

  // eslint-disable-next-line no-console
  const log = (msg: string): void => console.log(msg);

  const claude = await runClaudeVmE2e({ log });
  // eslint-disable-next-line no-console
  console.log("\n=== P2c claude-in-VM E2E: PASS ===");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(claude, null, 2));

  const git = await runGitWrapperE2e({ log });
  // eslint-disable-next-line no-console
  console.log("\n=== P2c git-wrapper E2E: PASS ===");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(git, null, 2));

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  // eslint-disable-next-line no-console
  console.log(`\n(${seconds}s wall-clock)`);
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("\n=== P2c E2E: FAIL ===");
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
