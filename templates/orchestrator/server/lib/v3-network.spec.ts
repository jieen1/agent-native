import { describe, expect, it } from "vitest";

import {
  isNetworkAllowed,
  isSymlinkSafe,
  isToolCommandAllowed,
} from "./v3-network.js";

// P4-B (Codex review 2026-07-23): these validators existed with confident
// "Security Boundary" doc comments but were never invoked from any caller
// and had zero test coverage. Now that `isToolCommandAllowed` is wired into
// the real bash execution path (acting-bridge.ts), these tests lock both
// halves of the contract: genuinely dangerous commands are rejected, and
// ordinary dev/build/test commands are NOT false-positive rejected.
describe("isToolCommandAllowed", () => {
  it("rejects disabled binaries as the base command", () => {
    expect(isToolCommandAllowed("sudo apt-get install foo")).toBe(false);
    expect(isToolCommandAllowed("mount /dev/sda1 /mnt")).toBe(false);
    expect(isToolCommandAllowed("dd if=/dev/zero of=/dev/sda")).toBe(false);
    expect(isToolCommandAllowed("iptables -F")).toBe(false);
    expect(isToolCommandAllowed("reboot")).toBe(false);
    expect(isToolCommandAllowed("kill -9 1")).toBe(false);
  });

  it("rejects a disabled binary appearing as a later token (chained/piped)", () => {
    expect(isToolCommandAllowed("git sudo push")).toBe(false);
    expect(isToolCommandAllowed("echo hi && sudo rm -rf /var")).toBe(false);
    expect(isToolCommandAllowed("cat /etc/shadow | sudo tee /tmp/x")).toBe(
      false,
    );
  });

  it("rejects redirecting to a device file, but allows /dev/null", () => {
    expect(isToolCommandAllowed("echo pwned > /dev/sda")).toBe(false);
    expect(isToolCommandAllowed("some-noisy-cmd > /dev/null 2>&1")).toBe(true);
  });

  it("rejects rm -rf / and its common variants", () => {
    expect(isToolCommandAllowed("rm -rf /")).toBe(false);
    expect(isToolCommandAllowed("rm -fr /")).toBe(false);
    expect(isToolCommandAllowed("rm --recursive --force /")).toBe(false);
    expect(isToolCommandAllowed("rm -rf /*")).toBe(false);
  });

  it("rejects empty or non-string input", () => {
    expect(isToolCommandAllowed("")).toBe(false);
    expect(isToolCommandAllowed("   ")).toBe(false);
    // @ts-expect-error — defensive runtime check for non-string callers
    expect(isToolCommandAllowed(null)).toBe(false);
  });

  it("allows ordinary dev/build/test commands, including common shell idioms", () => {
    // Command substitution, semicolon chaining, and OR-fallback are routine
    // in real dev work — a prior revision of this function rejected all of
    // them outright, which would have broken most real bash usage the
    // moment this validator was actually enforced.
    expect(isToolCommandAllowed("pnpm build && pnpm test")).toBe(true);
    expect(isToolCommandAllowed('echo "$(git rev-parse HEAD)"')).toBe(true);
    expect(
      isToolCommandAllowed(
        'for f in $(git diff --name-only); do echo "$f"; done',
      ),
    ).toBe(true);
    expect(isToolCommandAllowed("mkdir -p /work/tmp || true")).toBe(true);
    expect(isToolCommandAllowed("cd /tmp; ls -la")).toBe(true);
    expect(isToolCommandAllowed("npm test 2>&1 | tee test.log")).toBe(true);
    expect(isToolCommandAllowed("rm -rf node_modules")).toBe(true);
    expect(isToolCommandAllowed("rm -rf dist/tmp")).toBe(true);
    expect(isToolCommandAllowed("git log --oneline -20")).toBe(true);
    expect(
      isToolCommandAllowed(
        `git commit -m "$(cat <<'EOF'\nfix: something\nEOF\n)"`,
      ),
    ).toBe(true);
  });
});

describe("isNetworkAllowed", () => {
  it("allows exact-match and subdomain hosts on the default allowlist", () => {
    expect(isNetworkAllowed("https://github.com/foo/bar")).toBe(true);
    expect(isNetworkAllowed("https://api.github.com/repos")).toBe(true); // subdomain wildcard of the allowed "github.com"
    expect(isNetworkAllowed("https://codeload.github.com/x")).toBe(true);
    expect(isNetworkAllowed("https://api.anthropic.com/v1/messages")).toBe(
      true,
    );
  });

  it("rejects hosts not on the allowlist", () => {
    expect(isNetworkAllowed("https://evil.example.com")).toBe(false);
  });

  it("allows file: URLs and rejects malformed/non-http(s) URLs", () => {
    expect(isNetworkAllowed("file:///etc/passwd")).toBe(true);
    expect(isNetworkAllowed("not a url")).toBe(false);
    expect(isNetworkAllowed("ftp://github.com/x")).toBe(false);
  });
});

describe("isSymlinkSafe", () => {
  it("allows paths that stay within the work root", () => {
    expect(isSymlinkSafe("/work/src/index.ts")).toBe(true);
    expect(isSymlinkSafe("src/index.ts")).toBe(true);
    expect(isSymlinkSafe("/work")).toBe(true);
  });

  it("rejects paths that escape the work root via ..", () => {
    expect(isSymlinkSafe("/work/../etc/passwd")).toBe(false);
    expect(isSymlinkSafe("../../etc/passwd")).toBe(false);
  });

  it("rejects empty or non-string input", () => {
    expect(isSymlinkSafe("")).toBe(false);
  });
});
