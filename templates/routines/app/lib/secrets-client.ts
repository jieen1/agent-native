/**
 * Ad-hoc secrets client helper for the keys page.
 *
 * The ad-hoc secrets endpoints (`/_agent-native/secrets/adhoc[/:name]`) are
 * FRAMEWORK routes, not app actions, and the framework does not export a client
 * helper for them. Per the root contract ("add the helper first … instead of
 * teaching raw fetch"), this module is the single named seam the keys UI uses,
 * so components never hand-write fetch to a framework route.
 *
 * Values are write-only: the list endpoint returns masked metadata (`last4`,
 * never the plaintext). `urlAllowlist` is the per-key origin allowlist enforced
 * by the engine on `${keys.X}` web-requests (see `secrets/substitution.ts`).
 *
 * All requests are same-origin (session cookie travels automatically) and go
 * through `agentNativePath` so a mounted base path is respected.
 */

import { agentNativePath } from "@agent-native/core/client";

const ADHOC_ENDPOINT = agentNativePath("/_agent-native/secrets/adhoc");

/** Masked ad-hoc secret metadata returned by the list endpoint. */
export interface AdHocSecret {
  name: string;
  scope: "user" | "workspace";
  scopeId: string;
  description: string | null;
  /** Last 4 chars of the value — the plaintext is never returned. */
  last4: string;
  /** Per-key allowed request origins, or null when unrestricted. */
  urlAllowlist: string[] | null;
  createdAt: number;
  updatedAt: number;
}

export interface SaveAdHocSecretInput {
  /** [A-Za-z0-9_-]+ — referenced from routine bodies as `${keys.NAME}`. */
  name: string;
  /** The plaintext value. Sent once; never returned by the list endpoint. */
  value: string;
  description?: string;
  scope?: "user" | "workspace";
  /** Origins (http/https) the key may be used against. Empty/omitted = unrestricted. */
  urlAllowlist?: string[];
}

async function parseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    // non-JSON error body
  }
  return `Request failed with status ${res.status}`;
}

/** List the current user's ad-hoc secrets (masked metadata only). */
export async function listAdHocSecrets(): Promise<AdHocSecret[]> {
  const res = await fetch(ADHOC_ENDPOINT, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as AdHocSecret[];
}

/** Create or update an ad-hoc secret (and its URL allowlist). */
export async function saveAdHocSecret(
  input: SaveAdHocSecretInput,
): Promise<{ ok: true; key: string }> {
  const res = await fetch(ADHOC_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: input.name,
      value: input.value,
      description: input.description,
      scope: input.scope,
      urlAllowlist: input.urlAllowlist,
    }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as { ok: true; key: string };
}

/** Delete an ad-hoc secret by name. */
export async function deleteAdHocSecret(
  name: string,
): Promise<{ ok: true; removed: boolean }> {
  const res = await fetch(`${ADHOC_ENDPOINT}/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as { ok: true; removed: boolean };
}
