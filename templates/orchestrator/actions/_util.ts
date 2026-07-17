import { customAlphabet } from "nanoid";

const gen = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 16);

/** Prefixed, url-safe id, e.g. "task_a1b2...". */
export function newId(prefix: string): string {
  return `${prefix}_${gen()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Secrets-vault key for a runtime config's real API key (vLLM/OpenAI-compatible
 * providers). Scoped `{scope:"user", scopeId: ownerEmail}` like the framework's
 * own `OPENAI_API_KEY` — the runtime config id is folded into the key itself
 * rather than used as `scopeId`, so the row stays inside the owning user's
 * normal secret scope. Shared by save-runtime-config, activate-runtime, and
 * test-runtime-config so all three agree on the same lookup.
 */
export function runtimeApiKeySecretKey(runtimeConfigId: string): string {
  return `runtime-api-key:${runtimeConfigId}`;
}
