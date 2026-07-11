// Model registry — the single source of truth mapping a model's real weight
// identity to the aliases spawns/threads reference (04 §7, DESIGN "F7 遥测与
// 身份单一事实源", SDLC-054). Spawns/threads only ever carry an ALIAS
// (`v3_spawns.model_ref`, `brain_threads.model`); this module is where an
// alias is reverse-looked-up to the real underlying weight name for
// telemetry attribution, and where a model is registered in the first place.
//
// FAKE-NAME REJECTION (SDLC-054 root cause): a non-Claude model (e.g. a local
// vLLM weight) was once registered/labeled with a `claude-*` alias, which made
// its telemetry/billing attribution masquerade as real Claude usage. Every
// write path in this module runs `assertAliasAllowed` FIRST — a `claude-*`
// alias is only accepted when the caller also asserts `isClaudeWeight: true`.

import { and, eq, desc } from "drizzle-orm";
import { getV3Db, v3Schema, resolveOwnerEmail } from "./db/index.js";

/** Structured error for a rejected fake-name registration (04 §7). */
export class AliasForbiddenError extends Error {
  readonly code = "alias-forbidden" as const;
  constructor(alias: string) {
    super(
      `Alias "${alias}" starts with "claude-" but isClaudeWeight is false — ` +
        `only a real Claude weight may register a claude-* alias (SDLC-054 ` +
        `fake-name guard).`,
    );
    this.name = "AliasForbiddenError";
  }
}

function uid(): string {
  return crypto.randomUUID();
}

/** Reject a fake claude-* alias BEFORE any DB read/write. Pure — no I/O. */
export function assertAliasAllowed(alias: string, isClaudeWeight: boolean): void {
  if (alias.startsWith("claude-") && !isClaudeWeight) {
    throw new AliasForbiddenError(alias);
  }
}

export interface RegistryUpsertInput {
  realName: string;
  alias: string;
  tier?: string | null;
  endpoint?: string | null;
  isClaudeWeight: boolean;
}

export interface RegistryUpsertResult {
  id: string;
  /** True when this alias was already registered against a DIFFERENT realName. */
  aliasChanged: boolean;
  previousRealName: string | null;
}

/**
 * Register or update a model's alias -> real-name mapping (owner-scoped —
 * `resolveOwnerEmail()` fails closed to the local single-user owner rather
 * than a blank/global scope). Re-pointing an EXISTING alias at a different
 * `realName` is "alias drift" (04 §7 "别名漂移可见") and is recorded as a
 * `registry.alias-changed` v3_events row so it shows up on the S9 registry
 * timeline instead of silently rewriting attribution history.
 */
export async function upsertModel(
  input: RegistryUpsertInput,
): Promise<RegistryUpsertResult> {
  assertAliasAllowed(input.alias, input.isClaudeWeight);

  const db = getV3Db();
  const ownerEmail = resolveOwnerEmail();

  // Owner-scoped read: only the caller's OWN alias rows are visible here, so a
  // tenant can never observe (and, via the UPDATE below, overwrite) another
  // owner's alias→real-name mapping. The table's global UNIQUE(alias) still
  // makes a first-come tenant own a given alias; a second tenant claiming the
  // same alias finds no prior of its own, takes the INSERT path, and is
  // rejected by that constraint rather than silently clobbering the first
  // tenant's row.
  const existing = await db
    .select()
    .from(v3Schema.v3ModelRegistry)
    .where(
      and(
        eq(v3Schema.v3ModelRegistry.alias, input.alias),
        eq(v3Schema.v3ModelRegistry.ownerEmail, ownerEmail),
      ),
    )
    .limit(1);
  const prior = existing[0] ?? null;
  const aliasChanged = !!prior && prior.realName !== input.realName;

  // Generated up front so a fresh insert can RETURN its real id (callers use it
  // to reference the new registry row) instead of an opaque placeholder.
  const newId = uid();

  if (prior) {
    await db
      .update(v3Schema.v3ModelRegistry)
      .set({
        realName: input.realName,
        tier: input.tier ?? null,
        endpoint: input.endpoint ?? null,
        isClaudeWeight: input.isClaudeWeight ? 1 : 0,
      })
      // Owner-scoped write (defense-in-depth on top of the owner-scoped read
      // above): the UPDATE can only ever touch a row the caller owns.
      .where(
        and(
          eq(v3Schema.v3ModelRegistry.id, prior.id),
          eq(v3Schema.v3ModelRegistry.ownerEmail, ownerEmail),
        ),
      );
  } else {
    await db.insert(v3Schema.v3ModelRegistry).values({
      id: newId,
      realName: input.realName,
      alias: input.alias,
      tier: input.tier ?? null,
      endpoint: input.endpoint ?? null,
      isClaudeWeight: input.isClaudeWeight ? 1 : 0,
      createdAt: new Date(),
      ownerEmail,
      orgId: null,
    });
  }

  if (aliasChanged && prior) {
    await writeRegistryEvent(
      "registry.alias-changed",
      {
        alias: input.alias,
        previousRealName: prior.realName,
        newRealName: input.realName,
      },
      ownerEmail,
    );
  }

  return {
    id: prior?.id ?? newId,
    aliasChanged,
    previousRealName: prior?.realName ?? null,
  };
}

/** List the caller-owned registry rows, newest first (S9 registry table). */
export async function listModels(): Promise<
  Array<{
    id: string;
    realName: string;
    alias: string;
    tier: string | null;
    endpoint: string | null;
    isClaudeWeight: boolean;
    createdAt: Date | null;
  }>
> {
  const db = getV3Db();
  const ownerEmail = resolveOwnerEmail();
  const rows = await db
    .select()
    .from(v3Schema.v3ModelRegistry)
    .where(eq(v3Schema.v3ModelRegistry.ownerEmail, ownerEmail))
    .orderBy(desc(v3Schema.v3ModelRegistry.createdAt));
  return rows.map((r) => ({
    id: r.id,
    realName: r.realName,
    alias: r.alias,
    tier: r.tier,
    endpoint: r.endpoint,
    isClaudeWeight: r.isClaudeWeight === 1,
    createdAt: r.createdAt,
  }));
}

export interface ResolveRealNameResult {
  /** The resolved real weight name, or the alias itself when unregistered. */
  realName: string | null;
  /** True when the alias has no registry match — attribution unconfirmed. */
  suspect: boolean;
}

/**
 * Reverse-lookup: a spawn's `model_ref` ALIAS -> real weight identity for
 * telemetry attribution (04 §7/§10). Scoped by an EXPLICIT `ownerEmail` (the
 * owning node/spawn's owner) rather than ambient request context — this is
 * called from the dispatcher's background spawn-completion path, which is not
 * necessarily inside a request context `resolveOwnerEmail()` could read.
 *
 * An unregistered alias returns the alias itself as a best-effort label (never
 * null when a modelRef was given) with `suspect: true`, so a downstream reader
 * knows the attribution was never confirmed against the registry rather than
 * silently treating an absent mapping the same as a confirmed one.
 */
export async function resolveRealName(
  modelRef: string | null | undefined,
  ownerEmail: string,
): Promise<ResolveRealNameResult> {
  if (!modelRef) return { realName: null, suspect: false };
  const db = getV3Db();
  const rows = await db
    .select({ realName: v3Schema.v3ModelRegistry.realName })
    .from(v3Schema.v3ModelRegistry)
    .where(
      and(
        eq(v3Schema.v3ModelRegistry.alias, modelRef),
        eq(v3Schema.v3ModelRegistry.ownerEmail, ownerEmail),
      ),
    )
    .limit(1);
  const hit = rows[0];
  if (hit) return { realName: hit.realName, suspect: false };
  return { realName: modelRef, suspect: true };
}

async function writeRegistryEvent(
  kind: string,
  payload: Record<string, unknown>,
  ownerEmail: string,
): Promise<void> {
  const db = getV3Db();
  await db.insert(v3Schema.v3Events).values({
    id: uid(),
    runId: null,
    spawnId: null,
    kind,
    payload,
    seqNum: null,
    ts: new Date(),
    ownerEmail,
    orgId: null,
  });
}
