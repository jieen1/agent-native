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
      "Local Claude Code OAuth, mounted read-only into a claude-code node's microVM so it reuses your Pro/Max login (not an API key).",
    mountedBy: ["claude-code"],
  });

  return keyResults;
}
