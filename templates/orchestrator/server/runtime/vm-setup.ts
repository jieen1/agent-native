// Base-image toolchain ensure (DESIGN §7.4.8). A node's microVM must carry
// node + git + the `claude` CLI before the EXECUTE stage runs. Two paths:
//
//   PREFERRED — a PREBAKED OCI image (`orchestrator/node-base:1`, §7.4.8) pinned
//   via `runtime.image`, so INIT is fast (no per-node re-install). The bake is a
//   CLI step (documented in docs/runtime-image.md); the registry in `images.ts`
//   describes it.
//
//   FALLBACK (works today on the bare `alpine` base) — install the toolchain on
//   INIT through the VM's public egress: `apk add --no-cache nodejs npm git curl`
//   then `npm i -g @anthropic-ai/claude-code`. PROVEN on a real microVM
//   (2026-06-21): with DNS fixed + direct NAT egress, `apk add` and the global
//   npm install succeed and `claude --version` runs in-VM. This is the slow cold
//   path the prebake exists to avoid, but it makes a claude node WORK on the
//   stock image without a bake.
//
// `ensureToolchain` detects which tools are already present (a prebaked image
// short-circuits the whole install) and only installs what's missing, so a real
// prebaked image pays ~zero INIT cost.

import type { NodeRuntime, VmHandle } from "./node-runtime.js";

/** Which tools the node toolchain requires in the VM. */
export interface ToolchainNeeds {
  /** Require `node` + `npm` (always for a claude node; the CLI is a node pkg). */
  node: boolean;
  /** Require `git` (any code node that commits/pushes). */
  git: boolean;
  /** Require the `claude` CLI (claude-code nodes only). */
  claude: boolean;
}

/** The outcome of an ensure pass (what was found / installed). */
export interface ToolchainResult {
  /** Tools present BEFORE this pass (a prebaked image has them all). */
  before: { node: boolean; npm: boolean; git: boolean; claude: boolean };
  /** Whether an apk/npm install ran (false ⇒ prebaked / already present). */
  installed: boolean;
  /** Tools present AFTER the pass. */
  after: { node: boolean; npm: boolean; git: boolean; claude: boolean };
  /** Non-fatal log lines from the install (tails of apk/npm output). */
  log: string[];
}

/** Probe which of node/npm/git/claude are on PATH in the VM. */
export async function probeTools(
  runtime: NodeRuntime,
  vm: VmHandle,
  env: Record<string, string> = {},
): Promise<{ node: boolean; npm: boolean; git: boolean; claude: boolean }> {
  const res = await runtime.exec(
    vm,
    [
      `command -v node >/dev/null 2>&1 && echo node`,
      `command -v npm  >/dev/null 2>&1 && echo npm`,
      `command -v git  >/dev/null 2>&1 && echo git`,
      `command -v claude >/dev/null 2>&1 && echo claude`,
      `true`,
    ].join("; "),
    { env },
  );
  const out = res.stdout;
  return {
    node: /\bnode\b/.test(out),
    npm: /\bnpm\b/.test(out),
    git: /\bgit\b/.test(out),
    claude: /\bclaude\b/.test(out),
  };
}

/**
 * Ensure the VM has the toolchain `needs` requires (§7.4.8). Short-circuits when
 * everything is already present (a prebaked image). Otherwise installs via the
 * VM's public egress — `apk add` for node/npm/git/curl, then `npm i -g
 * @anthropic-ai/claude-code` for the CLI. `env` MUST carry the egress env
 * (DNS-fixed VM + any proxy) so the installs can reach the network.
 *
 * Throws with a clear message if, after installing, a REQUIRED tool is still
 * missing — a claude node with no `claude` is a hard failure, not silent.
 */
export async function ensureToolchain(
  runtime: NodeRuntime,
  vm: VmHandle,
  needs: ToolchainNeeds,
  env: Record<string, string> = {},
): Promise<ToolchainResult> {
  const before = await probeTools(runtime, vm, env);
  const log: string[] = [];

  const needNode = needs.node || needs.claude; // claude CLI is a node package
  const wantApk =
    (needNode && (!before.node || !before.npm)) || (needs.git && !before.git);
  const wantClaude = needs.claude && !before.claude;

  let installed = false;

  if (wantApk) {
    // alpine: refresh the index then add the toolchain. `--no-cache` keeps the
    // image small. curl is added so later egress probes prefer it over busybox
    // wget. A non-zero code is captured (not thrown) so we can report the tail.
    const pkgs = ["curl"];
    if (needNode) pkgs.push("nodejs", "npm");
    if (needs.git) pkgs.push("git");
    const apk = await runtime.exec(
      vm,
      `apk update >/dev/null 2>&1; apk add --no-cache ${pkgs.join(" ")} 2>&1`,
      { env, timeoutMs: 240_000 },
    );
    installed = true;
    log.push(`apk add ${pkgs.join(" ")} (code ${apk.code})`);
    if (apk.code !== 0) log.push(tail(apk.stdout));
  }

  if (wantClaude) {
    const npm = await runtime.exec(
      vm,
      `npm install -g @anthropic-ai/claude-code 2>&1`,
      { env, timeoutMs: 300_000 },
    );
    installed = true;
    log.push(`npm i -g @anthropic-ai/claude-code (code ${npm.code})`);
    if (npm.code !== 0) log.push(tail(npm.stdout));
  }

  const after = await probeTools(runtime, vm, env);

  // Hard-fail if a REQUIRED tool is still missing after install.
  const missing: string[] = [];
  if (needNode && (!after.node || !after.npm)) missing.push("node/npm");
  if (needs.git && !after.git) missing.push("git");
  if (needs.claude && !after.claude) missing.push("claude");
  if (missing.length > 0) {
    throw new Error(
      `ensureToolchain: required tools still missing after install: ` +
        `${missing.join(", ")}. Install log:\n${log.join("\n")}`,
    );
  }

  return { before, installed, after, log };
}

/** Last ~400 chars of a stream (for compact error/log context). */
function tail(text: string): string {
  return text.length > 400 ? `…${text.slice(-400)}` : text;
}
