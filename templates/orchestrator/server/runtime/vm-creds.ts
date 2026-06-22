// In-VM credential mounting (DESIGN §7.4.7). Two distinct credential sources a
// node needs, both injected at MOUNT/INIT, NEVER baked into source:
//
//   1. `~/.claude` (the local Claude Code subscription OAuth) — copied into a
//      claude-code node's microVM so the in-VM `claude` reuses your Pro/Max login
//      (not an API key). microsandbox has no live `--mount-dir` for a running
//      detached VM, so we COPY the host `~/.claude` into the VM's `$HOME`
//      (landing at `$HOME/.claude`). The copy is a DISPOSABLE per-VM clone, left
//      WRITABLE so the in-VM `claude` can refresh its OAuth token within the run;
//      nothing is written back to the host (the §7.4.7 read-only trade-off only
//      concerned refresh PERSISTENCE to the host, which a disposable VM doesn't
//      need). The host `~/.claude` is never modified.
//
//   2. `GITHUB_TOKEN` — git push / PR auth, resolved at run time via the
//      framework Vault (`resolveSecret`) inside the run's request context and
//      injected as scoped VM env only. We surface PRESENCE for journaling but
//      never log the value.
//
// HOME inside the VM defaults to `/root` (alpine root). We set HOME explicitly on
// every exec so `claude` and `git` find `~/.claude` / global git config.

import { resolveCredentialForVm } from "./credentials.js";
import type { NodeRuntime, VmHandle } from "./node-runtime.js";

/** The in-VM HOME we standardize on (alpine root). */
export const VM_HOME = "/root";

/** The host path to the local Claude Code subscription dir. */
export function hostClaudeDir(): string {
  // Honor an override (the WSL `bot` user's home in this env); default to the
  // running user's HOME. We resolve to a POSIX path the WSL `msb cp` can read.
  const override = process.env.ORCHESTRATOR_CLAUDE_DIR;
  if (override && override.trim() !== "") return override;
  return "/home/bot/.claude";
}

/** Result of mounting credentials into a VM (value-safe; presence only). */
export interface VmCredsResult {
  /** True if `~/.claude` was copied into the VM (claude subscription mount). */
  claudeMounted: boolean;
  /** True if a GITHUB_TOKEN value resolved and was injected as VM env. */
  githubTokenPresent: boolean;
  /** The env additions to thread into in-VM commands (HOME + GITHUB_TOKEN). */
  env: Record<string, string>;
}

/**
 * Copy the host `~/.claude` into the VM so the in-VM `claude` reuses the
 * subscription (§7.4.7). Best-effort: returns false if the host dir is absent or
 * the copy fails (a vLLM/non-claude node does not need it). The copy uses
 * `fs().copyFromHost` (→ `msb cp`).
 *
 * IMPORTANT (`msb cp` semantics): `msb cp <srcDir> <vm>:<destDir>` copies the
 * source directory AS A CHILD of an existing destDir — so copying `~/.claude`
 * into `$HOME/.claude` would land it at `$HOME/.claude/.claude` (wrong). We copy
 * the `.claude` dir INTO `$HOME` (`copyFromHost(src, home)`) so it lands exactly
 * at `$HOME/.claude` where `claude` looks for `.credentials.json`. Verified on a
 * real microVM (2026-06-21).
 *
 * The copy is left WRITABLE (no chmod): the VM is a disposable copy, so letting
 * the in-VM `claude` refresh its OAuth token within the run is strictly better
 * than a read-only mount (the §7.4.7 RO trade-off only matters for refresh
 * PERSISTENCE back to the host, which a disposable VM never needs).
 */
export async function mountClaudeSubscription(
  runtime: NodeRuntime,
  vm: VmHandle,
  home: string = VM_HOME,
): Promise<boolean> {
  const src = hostClaudeDir();
  try {
    await runtime.exec(vm, `mkdir -p ${home}`);
    // Remove any stale target so a re-mount doesn't nest under an existing dir.
    await runtime.exec(vm, `rm -rf ${home}/.claude`);
    // Copy the `.claude` dir INTO $HOME → lands at $HOME/.claude (see doc above).
    await runtime.fs(vm).copyFromHost(src, home);
    // claude ALSO reads the global config FILE at $HOME/.claude.json — a SIBLING
    // of the `.claude` dir, not inside it. It is REQUIRED once claude uses tools
    // or runs with `--dangerously-skip-permissions` (otherwise: "Claude
    // configuration file not found at: /root/.claude.json" → exit 1). Copy it
    // too (best-effort): the disposable VM reuses the host's onboarding + account
    // state; a missing MCP server listed inside is non-fatal (claude logs +
    // continues). `${src}.json` == `<...>/.claude.json` for the standard layout.
    try {
      await runtime.fs(vm).copyFromHost(`${src}.json`, home);
    } catch {
      // Optional — a no-tool prompt can still run without it.
    }
    // Sanity: the credentials file must be present for the in-VM claude to auth.
    const check = await runtime.exec(
      vm,
      `test -f ${home}/.claude/.credentials.json && echo OK || echo MISSING`,
    );
    return check.stdout.includes("OK");
  } catch {
    return false;
  }
}

/**
 * Resolve GITHUB_TOKEN from the Vault (audited, value-safe presence) and return
 * it as scoped VM env. The caller MUST already be inside the run's request
 * context so `resolveSecret` scopes to the owner (§7.4.7). Returns presence +
 * the env addition; the value is only ever placed in the env map, never logged.
 */
export async function resolveGithubTokenEnv(
  opts: { nodeRunId?: string | null } = {},
): Promise<{ present: boolean; env: Record<string, string> }> {
  const token = await resolveCredentialForVm("GITHUB_TOKEN", {
    nodeRunId: opts.nodeRunId ?? null,
  });
  if (token && token.trim() !== "") {
    return { present: true, env: { GITHUB_TOKEN: token } };
  }
  return { present: false, env: {} };
}

/**
 * Mount all node credentials into the VM (§7.4.7): the `~/.claude` subscription
 * (a writable disposable copy; the host copy is never modified) for claude nodes,
 * and GITHUB_TOKEN as scoped env for git push/PR.
 * `wantClaude` lets a non-claude node skip the subscription copy. Always sets
 * HOME so the in-VM `claude`/`git` find their config. Never throws on a missing
 * optional credential — presence is reported so the caller can fail later with a
 * clear message if a required credential is absent.
 */
export async function mountVmCredentials(
  runtime: NodeRuntime,
  vm: VmHandle,
  opts: {
    wantClaude: boolean;
    home?: string;
    nodeRunId?: string | null;
  },
): Promise<VmCredsResult> {
  const home = opts.home ?? VM_HOME;
  const env: Record<string, string> = { HOME: home };

  let claudeMounted = false;
  if (opts.wantClaude) {
    claudeMounted = await mountClaudeSubscription(runtime, vm, home);
  }

  const gh = await resolveGithubTokenEnv({ nodeRunId: opts.nodeRunId ?? null });
  Object.assign(env, gh.env);

  return {
    claudeMounted,
    githubTokenPresent: gh.present,
    env,
  };
}
