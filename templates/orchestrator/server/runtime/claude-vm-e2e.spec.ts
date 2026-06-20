import { describe, it, expect } from "vitest";

// GATED real claude-in-VM E2E (DESIGN §7.4.1a / §7.0). This boots a real libkrun
// microVM, fixes its DNS for direct public egress, mounts the host `~/.claude`,
// installs the `claude` CLI, and runs the REAL `claude` in-VM against the
// Anthropic API — so it is OFF by default (slow + needs KVM + a real ~/.claude
// login). Enable with RUN_CLAUDE_VM_E2E=1. The runnable proof is
// `claude-vm-e2e-cli.ts`.
//
// `claude-vm-e2e.js` pulls in the full runtime stack (request-context, engines),
// which vitest's collection-time ESM transform cannot resolve, so we import it
// LAZILY inside the gated test body — the default `pnpm test` stays fast.
const enabled = process.env.RUN_CLAUDE_VM_E2E === "1";

describe.skipIf(!enabled)("ClaudeCodeExecutor real claude-in-VM E2E", () => {
  it("real claude runs IN the microVM, reaches the API, spends tokens", async () => {
    const { msbAvailable } = await import("./wsl-msb.js");
    const { runClaudeVmE2e, CLAUDE_MARKER } = await import("./claude-vm-e2e.js");
    if (!(await msbAvailable())) {
      throw new Error("RUN_CLAUDE_VM_E2E=1 set but wsl/msb is not available");
    }
    const r = await runClaudeVmE2e({});
    expect(r.reply).not.toBe(""); // (a) real reply → API reached
    expect(r.reply.toUpperCase()).toContain(CLAUDE_MARKER);
    expect(r.replyMatches).toBe(true);
    expect(r.tokensSpent).toBeGreaterThan(0); // (b) real usage
    expect(r.egress.directEgress || r.egress.proxyUrl).toBeTruthy(); // egress works
    expect(r.claudeMounted).toBe(true); // (c) subscription mounted
    expect(r.removedFromVm).toBe(true); // (e) teardown removed VM
  }, 600_000);

  it("git wrapper: branch + commit succeed in-VM; push fails clearly w/o token", async () => {
    const { runGitWrapperE2e } = await import("./claude-vm-e2e.js");
    const r = await runGitWrapperE2e({});
    expect(r.committed).toBe(true); // commit happened in-VM
    expect(r.commitSha).not.toBeNull();
    expect(r.pushPushed).toBe(false); // push did NOT silently succeed
    expect(r.pushReason).toBe("no-token"); // it failed CLEARLY
  }, 300_000);
});
