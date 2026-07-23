// isAgentEnginePackageInstalled's ESM-exports fallback — 2026-07-23 second-
// order fix (Codex review), kept in its OWN file (not registry.spec.ts,
// which already carries a lot of real registry/resolveEngine state) so each
// test can `vi.resetModules()` + `vi.doMock("node:module", ...)` for a FRESH
// module instance with fully controlled `require.resolve` behavior. Mirrors
// `agent/harness/registry-package-resolution.spec.ts`, whose sibling fix
// (2026-07-23) this twin bug had been missed from.
//
// A package that ships `"type": "module"` with an `"exports"` map defining
// only an `"import"` condition for `"."` has no `"main"` Node's CJS resolver
// can fall back to, so a bare `require.resolve(packageName)` throws
// ERR_PACKAGE_PATH_NOT_EXPORTED regardless of whether the package is
// actually installed — this would silently misreport an ESM-only agent
// ENGINE package as "not installed" the moment one is registered.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentEngineEntry } from "./registry.js";

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

describe("isAgentEnginePackageInstalled — ESM-exports-map fallback", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("node:module");
  });

  const entry = (installPackage: string): AgentEngineEntry =>
    ({ installPackage }) as AgentEngineEntry;

  it("returns true when the bare specifier resolves normally (ordinary CJS-compatible package)", async () => {
    const behavior = new Map<string, string | NodeJS.ErrnoException>([
      [
        "some-normal-engine-pkg",
        "/node_modules/some-normal-engine-pkg/index.js",
      ],
    ]);
    const { isAgentEnginePackageInstalled } =
      await loadRegistryWithMockedResolve(behavior);
    expect(isAgentEnginePackageInstalled(entry("some-normal-engine-pkg"))).toBe(
      true,
    );
  });

  it("returns false when the package genuinely does not exist (MODULE_NOT_FOUND)", async () => {
    const { isAgentEnginePackageInstalled } =
      await loadRegistryWithMockedResolve(new Map());
    expect(isAgentEnginePackageInstalled(entry("totally-missing-pkg"))).toBe(
      false,
    );
  });

  // The actual bug: an ESM-only engine package must not be misreported as
  // not-installed just because require.resolve() can't see its "exports" map.
  it("falls back to resolving package.json and reports installed when the bare specifier throws ERR_PACKAGE_PATH_NOT_EXPORTED", async () => {
    const behavior = new Map<string, string | NodeJS.ErrnoException>([
      [
        "@some-scope/esm-only-engine",
        makeError(
          "ERR_PACKAGE_PATH_NOT_EXPORTED",
          'No "exports" main defined in .../esm-only-engine/package.json',
        ),
      ],
      [
        "@some-scope/esm-only-engine/package.json",
        "/node_modules/@some-scope/esm-only-engine/package.json",
      ],
    ]);
    const { isAgentEnginePackageInstalled } =
      await loadRegistryWithMockedResolve(behavior);
    expect(
      isAgentEnginePackageInstalled(entry("@some-scope/esm-only-engine")),
    ).toBe(true);
  });

  it("still reports NOT installed when even the package.json fallback fails (genuinely absent, not just an exports quirk)", async () => {
    const behavior = new Map<string, string | NodeJS.ErrnoException>([
      [
        "@some-scope/esm-only-engine",
        makeError("ERR_PACKAGE_PATH_NOT_EXPORTED", "no exports main"),
      ],
      // No package.json entry — the fallback resolve also throws.
    ]);
    const { isAgentEnginePackageInstalled } =
      await loadRegistryWithMockedResolve(behavior);
    expect(
      isAgentEnginePackageInstalled(entry("@some-scope/esm-only-engine")),
    ).toBe(false);
  });

  it("does not use the package.json fallback for an ordinary MODULE_NOT_FOUND (only for the exports-map quirk)", async () => {
    const behavior = new Map<string, string | NodeJS.ErrnoException>([
      ["some-pkg/package.json", "/node_modules/some-pkg/package.json"],
    ]);
    const { isAgentEnginePackageInstalled } =
      await loadRegistryWithMockedResolve(behavior);
    expect(isAgentEnginePackageInstalled(entry("some-pkg"))).toBe(false);
  });

  it("requires every space-separated package in installPackage to resolve", async () => {
    const behavior = new Map<string, string | NodeJS.ErrnoException>([
      ["pkg-a", "/node_modules/pkg-a/index.js"],
    ]);
    const { isAgentEnginePackageInstalled } =
      await loadRegistryWithMockedResolve(behavior);
    expect(isAgentEnginePackageInstalled(entry("pkg-a pkg-b"))).toBe(false);
  });
});
