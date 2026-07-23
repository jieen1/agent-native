// canResolvePackage / isAgentHarnessPackageInstalled's ESM-exports fallback —
// 2026-07-23 incident fix, kept in its OWN file (not registry.spec.ts) so
// each test can `vi.resetModules()` + `vi.doMock("node:module", ...)` for a
// FRESH module instance with fully controlled `require.resolve` behavior,
// without touching registry.spec.ts's existing real-registry tests.
//
// `@agentclientprotocol/claude-agent-acp` (the acp:claude-code harness's
// installPackage) ships `"type": "module"` with an `"exports"` map defining
// only an `"import"` condition for `"."` — once a package declares
// `"exports"`, Node's CJS resolver ignores the legacy `"main"` field
// entirely and throws ERR_PACKAGE_PATH_NOT_EXPORTED for a bare
// `require.resolve(packageName)`, REGARDLESS of whether the package is
// actually installed — confirmed live in production: a fully, correctly
// deployed package (real on-disk files, complete dependency closure) still
// failed this check, silently degrading every brain turn to the raw-spawn
// fallback with no indication the packages were, in fact, present.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function makeError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/** Fresh module instance per test, with `require.resolve` driven entirely
 * by `behavior` (specifier -> resolved path string, or an Error to throw). */
async function loadRegistryWithMockedResolve(
  behavior: Map<string, string | NodeJS.ErrnoException>,
) {
  vi.resetModules();
  vi.doMock("node:module", () => ({
    createRequire: () => ({
      resolve: (specifier: string) => {
        const outcome = behavior.get(specifier);
        if (outcome === undefined) {
          throw makeError(
            "MODULE_NOT_FOUND",
            `Cannot find module '${specifier}'`,
          );
        }
        if (typeof outcome === "string") return outcome;
        throw outcome;
      },
    }),
  }));
  return import("./registry.js");
}

describe("isAgentHarnessPackageInstalled — ESM-exports-map fallback", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("node:module");
  });

  it("returns true when the bare specifier resolves normally (ordinary CJS-compatible package)", async () => {
    const behavior = new Map<string, string | NodeJS.ErrnoException>([
      ["some-normal-pkg", "/node_modules/some-normal-pkg/index.js"],
    ]);
    const { isAgentHarnessPackageInstalled } =
      await loadRegistryWithMockedResolve(behavior);
    expect(
      isAgentHarnessPackageInstalled({ installPackage: "some-normal-pkg" }),
    ).toBe(true);
  });

  it("returns false when the package genuinely does not exist (MODULE_NOT_FOUND)", async () => {
    const { isAgentHarnessPackageInstalled } =
      await loadRegistryWithMockedResolve(new Map());
    expect(
      isAgentHarnessPackageInstalled({
        installPackage: "totally-missing-pkg",
      }),
    ).toBe(false);
  });

  // The actual incident.
  it("falls back to resolving package.json and reports installed when the bare specifier throws ERR_PACKAGE_PATH_NOT_EXPORTED", async () => {
    const behavior = new Map<string, string | NodeJS.ErrnoException>([
      [
        "@agentclientprotocol/claude-agent-acp",
        makeError(
          "ERR_PACKAGE_PATH_NOT_EXPORTED",
          'No "exports" main defined in .../claude-agent-acp/package.json',
        ),
      ],
      [
        "@agentclientprotocol/claude-agent-acp/package.json",
        "/node_modules/@agentclientprotocol/claude-agent-acp/package.json",
      ],
    ]);
    const { isAgentHarnessPackageInstalled } =
      await loadRegistryWithMockedResolve(behavior);
    expect(
      isAgentHarnessPackageInstalled({
        installPackage: "@agentclientprotocol/claude-agent-acp",
      }),
    ).toBe(true);
  });

  it("still reports NOT installed when even the package.json fallback fails (genuinely absent, not just an exports quirk)", async () => {
    const behavior = new Map<string, string | NodeJS.ErrnoException>([
      [
        "@agentclientprotocol/claude-agent-acp",
        makeError("ERR_PACKAGE_PATH_NOT_EXPORTED", "no exports main"),
      ],
      // No package.json entry — the fallback resolve also throws (default
      // MODULE_NOT_FOUND from the mock).
    ]);
    const { isAgentHarnessPackageInstalled } =
      await loadRegistryWithMockedResolve(behavior);
    expect(
      isAgentHarnessPackageInstalled({
        installPackage: "@agentclientprotocol/claude-agent-acp",
      }),
    ).toBe(false);
  });

  it("does not use the package.json fallback for an ordinary MODULE_NOT_FOUND (only for the exports-map quirk)", async () => {
    // Even though the package.json subpath WOULD resolve, a plain "not
    // found" on the bare specifier must not be papered over — only the
    // specific ERR_PACKAGE_PATH_NOT_EXPORTED shape triggers the fallback.
    const behavior = new Map<string, string | NodeJS.ErrnoException>([
      ["some-pkg/package.json", "/node_modules/some-pkg/package.json"],
    ]);
    const { isAgentHarnessPackageInstalled } =
      await loadRegistryWithMockedResolve(behavior);
    expect(isAgentHarnessPackageInstalled({ installPackage: "some-pkg" })).toBe(
      false,
    );
  });

  it("requires every space-separated package in installPackage to resolve", async () => {
    const behavior = new Map<string, string | NodeJS.ErrnoException>([
      ["pkg-a", "/node_modules/pkg-a/index.js"],
    ]);
    const { isAgentHarnessPackageInstalled } =
      await loadRegistryWithMockedResolve(behavior);
    // pkg-b unresolvable.
    expect(
      isAgentHarnessPackageInstalled({ installPackage: "pkg-a pkg-b" }),
    ).toBe(false);
  });
});
