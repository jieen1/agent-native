import { createRequire } from "node:module";

import type { AgentHarnessAdapter } from "./types.js";

const require = createRequire(import.meta.url);

export interface AgentHarnessEntry {
  name: string;
  label: string;
  description: string;
  installPackage?: string;
  capabilities: AgentHarnessAdapter["capabilities"];
  create(config?: Record<string, unknown>): AgentHarnessAdapter;
}

const registry = new Map<string, AgentHarnessEntry>();
const packageAvailabilityCache = new Map<string, boolean>();

export function registerAgentHarness(entry: AgentHarnessEntry): void {
  if (registry.has(entry.name) && process.env.NODE_ENV !== "test") {
    console.warn(
      `[agent-harness] Harness "${entry.name}" is already registered. Skipping.`,
    );
    return;
  }
  registry.set(entry.name, entry);
}

export function getAgentHarnessEntry(
  name: string,
): AgentHarnessEntry | undefined {
  return registry.get(name);
}

export function listAgentHarnesses(): AgentHarnessEntry[] {
  return Array.from(registry.values());
}

export function resolveAgentHarness(
  name: string,
  config?: Record<string, unknown>,
): AgentHarnessAdapter {
  const entry = registry.get(name);
  if (!entry) {
    throw new Error(`[agent-harness] Unknown harness "${name}"`);
  }
  assertAgentHarnessPackagesInstalled(entry);
  return entry.create(config);
}

export function isAgentHarnessPackageInstalled(
  entry: Pick<AgentHarnessEntry, "installPackage">,
): boolean {
  const packages =
    entry.installPackage
      ?.split(/\s+/)
      .map(packageNameFromInstallSpecifier)
      .filter((name): name is string => Boolean(name)) ?? [];
  return packages.every(canResolvePackage);
}

function assertAgentHarnessPackagesInstalled(entry: AgentHarnessEntry): void {
  if (isAgentHarnessPackageInstalled(entry)) return;
  const hint = entry.installPackage
    ? ` Run: pnpm add ${entry.installPackage}`
    : "";
  throw new Error(
    `[agent-harness] Harness "${entry.name}" requires optional packages that are not installed in this app.${hint}`,
  );
}

function packageNameFromInstallSpecifier(specifier: string): string | null {
  const trimmed = specifier.trim();
  if (!trimmed || trimmed.startsWith("-")) return null;
  if (trimmed.startsWith("@")) {
    const slashIndex = trimmed.indexOf("/");
    if (slashIndex === -1) return trimmed;
    const versionIndex = trimmed.indexOf("@", slashIndex + 1);
    return versionIndex === -1 ? trimmed : trimmed.slice(0, versionIndex);
  }
  const versionIndex = trimmed.indexOf("@");
  return versionIndex === -1 ? trimmed : trimmed.slice(0, versionIndex);
}

/**
 * Confirmed live-production bug (2026-07-23): `@agentclientprotocol/
 * claude-agent-acp` (the `acp:claude-code` harness's own installPackage) ships
 * `"type": "module"` with an `"exports"` map that defines only an `"import"`
 * condition for `"."` — no `"require"`. Once a package declares `"exports"`,
 * Node's CJS resolver ignores the legacy `"main"` field entirely and throws
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` for a bare `require.resolve(packageName)`,
 * REGARDLESS of whether the package is actually installed correctly — this
 * package can never satisfy that check, on any deployment, forever. That
 * made this function report the harness as unavailable even immediately
 * after a from-scratch, fully-correct deploy (confirmed: the package was
 * genuinely present on disk with a complete dependency closure; only this
 * resolution style failed), silently degrading every brain turn to the
 * raw-spawn fallback and erasing the exact reason ("packages not installed")
 * a human would look for — the packages WERE installed; the check just
 * couldn't see them. The registry itself never `require`s this package's
 * code directly (acp-adapter.ts reaches it via a real `await import()`,
 * which DOES honor the "import" condition) — this function only needs to
 * answer "is the package physically present", not "can THIS specific
 * resolution style load its main entry". Falling back to resolving the
 * package's own `package.json` sidesteps the module-format question
 * entirely (a JSON file has no import/require distinction) and still proves
 * real, on-disk presence — nearly every real npm package's `exports` map
 * either explicitly serves `"./package.json"` or (as here) a `"./*"`
 * wildcard that passes it through.
 */
function canResolvePackage(packageName: string): boolean {
  const cached = packageAvailabilityCache.get(packageName);
  if (cached !== undefined) return cached;
  let available = false;
  try {
    require.resolve(packageName);
    available = true;
  } catch (err) {
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
    ) {
      try {
        require.resolve(`${packageName}/package.json`);
        available = true;
      } catch {
        available = false;
      }
    } else {
      available = false;
    }
  }
  packageAvailabilityCache.set(packageName, available);
  return available;
}
