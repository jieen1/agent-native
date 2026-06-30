// In-VM credential mounting (DESIGN §13/§19).
//
// Only one credential source is injected into microVMs:
//
//   `GITHUB_TOKEN` — git push / PR auth, resolved at run time via the
//   framework Vault (`resolveSecret`) inside the run's request context and
//   injected as scoped VM env only. We surface PRESENCE for journaling but
//   never log the value.
//
// DESIGN §13/§19 explicitly forbid copying the host `~/.claude` subscription into
// microVMs — the OAuth token does not survive multi-VM contexts. For Claude Code
// as a worker, use `runtime: acp:claude-code` instead.
//
// HOME inside the VM defaults to `/root` (alpine root). We set HOME explicitly on
// every exec so `git` finds the global git config.

import { resolveCredentialForVm } from "./credentials.js";
import type { VmHandle } from "./node-runtime.js";

/** The in-VM HOME we standardize on (alpine root). */
export const VM_HOME = "/root";

// ── Secret Scrubbing (DESIGN §13/§18) ────────────────────────────────────────

/**
 * Known secret token prefixes. Text matching these patterns is redacted before
 * being persisted to logs or returned to the model (DESIGN §13/§18: "API keys
 * never in artifacts/logs; worker shim sanitizes stderr").
 *
 * Prefixes: sk- (OpenAI/Anthropic API keys), ghp_ (GitHub personal tokens),
 * ghs_ (GitHub app tokens), gho_ (GitHub OAuth tokens), github_pat_ (fine-grained).
 */
const SECRET_PREFIX_RE =
  /\b(sk-[A-Za-z0-9_\-]{8,}|ghp_[A-Za-z0-9]{8,}|ghs_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g;

/**
 * Scrub a log/stderr string against known secret prefixes and any explicitly
 * supplied secret values (DESIGN §13/§18).
 *
 * @param text — the raw stderr or log string to sanitize
 * @param extraSecrets — optional list of resolved secret values to redact
 *   verbatim (the caller supplies values it knows about, e.g. GITHUB_TOKEN).
 * @returns the scrubbed string with secrets replaced by "***"
 */
export function scrubSecretsFromLog(
  text: string,
  extraSecrets: readonly string[] = [],
): string {
  let out = text;
  // Redact known-prefix tokens.
  out = out.replace(SECRET_PREFIX_RE, "***");
  // Redact any explicitly supplied secret values.
  for (const secret of extraSecrets) {
    if (!secret || secret.trim() === "") continue;
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "g"), "***");
  }
  return out;
}

/** Result of mounting credentials into a VM (value-safe; presence only). */
export interface VmCredsResult {
  /**
   * Always false — ~/.claude subscription copying is forbidden by DESIGN §13/§19.
   * Claude Code as worker must use `runtime: acp:claude-code` instead.
   */
  claudeMounted: false;
  /** True if a GITHUB_TOKEN value resolved and was injected as VM env. */
  githubTokenPresent: boolean;
  /** The env additions to thread into in-VM commands (HOME + GITHUB_TOKEN). */
  env: Record<string, string>;
}

/**
 * Resolve GITHUB_TOKEN from the Vault (audited, value-safe presence) and return
 * it as scoped VM env. The caller MUST already be inside the run's request
 * context so `resolveSecret` scopes to the owner (DESIGN §13). Returns presence +
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
 * Inject GITHUB_TOKEN (resolved ephemerally from the Vault) into the VM env for
 * git push/PR. Always sets HOME so `git` finds the global git config.
 *
 * DESIGN §13/§19: ~/.claude subscription copying is explicitly forbidden —
 * the OAuth token does not survive multi-VM contexts. For Claude Code as a worker,
 * use `runtime: acp:claude-code` instead. Callers that previously passed
 * `wantClaude: true` should switch to ACP.
 *
 * Never throws on a missing optional credential — presence is reported so the
 * caller can fail later with a clear message if a required credential is absent.
 */
export async function mountVmCredentials(
  _vm: VmHandle,
  opts: {
    /** Accepted for backwards compatibility; IGNORED — use acp:claude-code. */
    wantClaude?: boolean;
    home?: string;
    nodeRunId?: string | null;
  },
): Promise<VmCredsResult> {
  const home = opts.home ?? VM_HOME;
  const env: Record<string, string> = { HOME: home };

  const gh = await resolveGithubTokenEnv({ nodeRunId: opts.nodeRunId ?? null });
  Object.assign(env, gh.env);

  return {
    claudeMounted: false,
    githubTokenPresent: gh.present,
    env,
  };
}
