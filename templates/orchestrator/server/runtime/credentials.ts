// Credential KEY registry (DESIGN §7.4.7, FRONTEND §9 Credentials tab).
//
// Lists which secret KEYS the runtime cares about, whether each is REGISTERED
// (present), and which runtime/node kind mounts it into its microVM env. It
// reuses the framework secret surface (`resolveSecret`) for the presence check
// and NEVER decrypts or returns a secret VALUE — only a boolean "present".
//
// The keys mirror §7.4.7's credential table: GITHUB_TOKEN (git push / PR),
// OPENAI_API_KEY (the vLLM/OpenAI-compatible usability gate — vLLM ignores the
// value but the engine requires it set), ANTHROPIC_API_KEY (hosted Claude
// nodes), plus the local `~/.claude` subscription mount (not a secret KEY but
// surfaced so the user sees the claude node's credential source).

import { resolveSecret } from "@agent-native/core/server";
import { getClaudeCodeAuthStatus } from "../claude-code-status.js";
import { writeAudit } from "../audit/write-audit.js";

/** A credential key the runtime mounts, with its presence + which nodes use it. */
export interface CredentialKey {
  /** The secret key name (never its value). */
  key: string;
  /** True when the key resolves to a value (env / Vault / app_secrets). */
  present: boolean;
  /** What the credential is for. */
  description: string;
  /** Which runtime/node kinds inject it into their microVM env (§7.4.7). */
  mountedBy: string[];
}

/** The static catalog of credential keys the runtime injects (§7.4.7). */
interface KeySpec {
  key: string;
  description: string;
  mountedBy: string[];
}

const KEY_SPECS: KeySpec[] = [
  {
    key: "GITHUB_TOKEN",
    description:
      "Git push + PR auth for code nodes (injected as a scoped VM credential helper, never baked into source).",
    mountedBy: ["claude-code", "vllm", "openai-compatible"],
  },
  {
    key: "OPENAI_API_KEY",
    description:
      "Usability gate for the built-in ai-sdk:openai engine. vLLM ignores the value; activate-runtime writes a server-side placeholder.",
    mountedBy: ["vllm", "openai-compatible"],
  },
  {
    key: "ANTHROPIC_API_KEY",
    description: "Hosted Claude (remote-API) nodes that use the Anthropic API.",
    mountedBy: ["remote-api"],
  },
];

/**
 * Resolve a credential VALUE for injection into a node's microVM (DESIGN
 * §7.4.7), writing an AUDIT row for the resolution. This is the audited seam the
 * VM mount/inject path uses so every credential resolution leaves a trail —
 * with the KEY name and a `present` boolean ONLY, never the decrypted value
 * (mirrors the value-safe presence list). Returns the resolved value, or null.
 *
 * Best-effort audit: an audit failure never blocks the resolution. A resolution
 * THROW is recorded as `present:false` then rethrown so the caller still fails.
 */
export async function resolveCredentialForVm(
  key: string,
  opts: { nodeRunId?: string | null } = {},
): Promise<string | null> {
  let value: string | null = null;
  let present = false;
  try {
    const resolved = await resolveSecret(key);
    value = (resolved as string | null) ?? null;
    present = value != null;
    return value;
  } finally {
    // Audit the resolution attempt regardless of outcome (key + present only).
    await writeAudit({
      action: "credential.resolve",
      targetType: "credential",
      targetId: key,
      detail: { present, nodeRunId: opts.nodeRunId ?? null },
    });
  }
}

/** A short note rendered under the read-only Credentials list. */
export const CREDENTIALS_NOTE =
  "Only key presence is shown — secret values are never displayed. Values live in the framework Vault / app_secrets; the runtime injects them as scoped microVM env (§7.4.7).";

/**
 * Resolve the credential-key registry: presence per key (value-safe) plus the
 * local Claude Code subscription mount (`~/.claude`), surfaced so the user sees
 * the claude node's credential source. Never returns a secret value.
 */
export async function listRuntimeCredentials(): Promise<CredentialKey[]> {
  const keyResults: CredentialKey[] = await Promise.all(
    KEY_SPECS.map(async (spec) => {
      let present = false;
      try {
        present = (await resolveSecret(spec.key)) != null;
      } catch {
        present = false;
      }
      return {
        key: spec.key,
        present,
        description: spec.description,
        mountedBy: spec.mountedBy,
      };
    }),
  );

  // The claude node mounts the local `~/.claude` OAuth (subscription), not a
  // secret KEY — surface it as a credential source so the picture is complete.
  let claudeLoggedIn = false;
  try {
    claudeLoggedIn = getClaudeCodeAuthStatus().loggedIn;
  } catch {
    claudeLoggedIn = false;
  }
  keyResults.push({
    key: "~/.claude (subscription)",
    present: claudeLoggedIn,
    description:
      "Local Claude Code OAuth, copied into a claude-code node's disposable microVM (the host copy is never modified) so it reuses your Pro/Max login (not an API key).",
    mountedBy: ["claude-code"],
  });

  return keyResults;
}
