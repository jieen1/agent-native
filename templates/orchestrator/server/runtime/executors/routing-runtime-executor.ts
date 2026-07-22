// RoutingRuntimeExecutor — wires the real, saved `runtime_configs` table into
// the V3 EXECUTE stage (DESIGN §7.4.1a), replacing the single hard-wired
// `RemoteApiExecutor` instance `v3-reconciler.ts` used to bind for EVERY node
// of EVERY run.
//
// Root cause this fixes: a non-claude-code DAG node's `engine` is almost
// always the generic worker placeholder "vllm" (`.claude/agents/vllm.md`),
// which only ever resolved through the env-var-bound `registerVllmEngine()`
// registry entry (`server/vllm-engine.ts`, pinned to `OPENAI_BASE_URL` at
// container boot) — completely disconnected from whichever `runtime_configs`
// row a user actually saved + activated in Settings (`save-runtime-config` /
// `activate-runtime` / `test-runtime-config`, which read/write that table and
// its `runtimeApiKeySecretKey`-scoped secret already).
//
// Resolution order (`selectRuntimeRoute`, pure + unit-tested in isolation):
//   1. node.engine EXACTLY matches a saved row id (excluding claude-code kind
//      rows — DAG worker nodes may never use the CC subscription runtime,
//      the same D-7 rule `executor-choice.ts` encodes) → that row, an
//      explicit per-node override. `WorkflowAgentNode.engine_override`
//      already supports an arbitrary string, so no new DAG field is needed.
//   2. node.engine is empty or a non-built-in placeholder (in practice
//      "vllm") AND the owner has an ACTIVE non-claude-code row → that row.
//   3. node.engine is a genuine built-in framework engine id (e.g.
//      "ai-sdk:openai", `implementer.md`'s choice) → no row match attempted;
//      falls through to RemoteApiExecutor exactly as before.
//   4. no matching/active row at all (nothing configured, or all configured
//      runtimes are claude-code) → RemoteApiExecutor, UNCHANGED — this is
//      the exact pre-existing default (`registerVllmEngine()` / OPENAI_BASE_URL)
//      that a user who has never opened Settings keeps getting.
//
// A matched row (kind "vllm" or "openai-compatible" — both are OpenAI-
// compatible endpoints, see `executors/index.ts`'s `executorForChoice`) drives
// a `VllmExecutor` pointed at the row's baseUrl/model, with the row's saved
// API key, so a real remote provider (e.g. Aliyun) is actually reached.
//
// Task #89 fix: reaching the right baseUrl/key is not enough — the MODEL NAME
// requested must also match what that row actually serves. A node's engine
// almost always resolves through its agent-def's own static `model` (e.g.
// `vllm`'s seeded `qwen3.6`), which a real remote provider row rarely serves,
// so `VllmExecutor.resolveModel` now prefers the matched row's own `model`
// over that static default — UNLESS the DAG node set an explicit
// `model_override` (threaded onto `Node.modelOverride`, `v3-dispatcher.ts`),
// which still wins as a deliberate per-node choice. See
// `vllm-executor.ts`'s `resolveModel` for the full precedence order; the
// RemoteApiExecutor fallback path (no row matched) is unaffected — it never
// sees a `cfg`, so it keeps using the agent-def's static model exactly as
// before.
//
// NOTE: `executor-choice.ts` / `routing-node-executor.ts` already solved this
// exact routing decision — but for a DIFFERENT seam (the scheduler-facing
// `NodeExecutor`/`RoutingNodeExecutor`, which is not instantiated ANYWHERE in
// this app; V3Dispatcher owns its own `NodeRunner` directly over a bare
// `RuntimeExecutor`, one layer below where `RoutingNodeExecutor` plugs in) and
// with a closed accepted-set that throws on the "vllm" placeholder literal
// (it is neither a built-in engine id nor normally a runtime_configs row id),
// which would break every existing vllm.md-engine node. This module reuses
// the same building blocks (`BUILTIN_ENGINES`, `VllmExecutor`,
// `RemoteApiExecutor`) at the seam V3 actually plugs into, and treats the
// placeholder as "no explicit choice" instead of an unknown one.

import { readAppSecret } from "@agent-native/core/secrets";
import { and, eq } from "drizzle-orm";

import { runtimeApiKeySecretKey } from "../../../actions/_util.js";
import { BUILTIN_ENGINES } from "../executor-choice.js";
import { RemoteApiExecutor } from "./remote-api-executor.js";
import type {
  RuntimeExecCtx,
  RuntimeExecResult,
  RuntimeExecutor,
} from "./types.js";
import { VllmExecutor, type VllmExecutorConfig } from "./vllm-executor.js";

/** A saved runtime_configs row, scoped to one owner, with the `active` flag. */
export interface OwnerRuntimeRow {
  id: string;
  name: string;
  kind: "vllm" | "openai-compatible" | "claude-code";
  baseUrl: string | null;
  model: string | null;
  active: number;
}

/**
 * Pick which saved runtime_configs row (if any) a node's engine choice should
 * route to. PURE — no IO, unit-testable in isolation (mirrors
 * `executor-choice.ts`'s `resolveNodeExecutorChoice`). claude-code-kind rows
 * are excluded even from an explicit id match — a DAG worker node may never
 * resolve to the CC subscription runtime.
 */
export function selectRuntimeRoute(
  node: { engine?: string | null },
  rows: readonly OwnerRuntimeRow[],
): OwnerRuntimeRow | undefined {
  const engineChoice = (node.engine ?? "").trim();
  const eligible = rows.filter((r) => r.kind !== "claude-code");

  const explicit = eligible.find((r) => r.id === engineChoice);
  if (explicit) return explicit;

  if ((BUILTIN_ENGINES as readonly string[]).includes(engineChoice)) {
    return undefined;
  }

  return eligible.find((r) => r.active === 1);
}

/**
 * `runtime_configs.active` is physically `bigint` in Postgres (see
 * `orchestrator_migration_hashes`-adjacent F6 investigation, 2026-07-22):
 * postgres.js returns bigint columns as JS STRINGS by default, and drizzle's
 * `integer()` column mapper does not re-coerce them for this partial-select
 * shape — confirmed empirically against the real driver. Left as `r.active
 * === 1`, this NEVER matches (`"1" === 1` is false), so `selectRuntimeRoute`
 * silently treats every owner as having no active row and falls through to
 * the hardcoded `RemoteApiExecutor`/`OPENAI_BASE_URL` fallback regardless of
 * what `activate-runtime` set — the exact bug behind "switching to Aliyun in
 * Settings doesn't change what a DAG dev node actually runs on". Normalize
 * here, once, so every caller can trust `OwnerRuntimeRow.active` really is a
 * number.
 */
function normalizeActive<T extends { active: unknown }>(
  row: T,
): T & { active: number } {
  return { ...row, active: Number(row.active) };
}

/** Load every saved runtime_configs row for one owner (production default). */
async function loadOwnerRuntimeRows(
  ownerEmail: string,
): Promise<OwnerRuntimeRow[]> {
  const { getDb, schema } = await import("../../db/index.js");
  const rows = await getDb()
    .select({
      id: schema.runtimeConfigs.id,
      name: schema.runtimeConfigs.name,
      kind: schema.runtimeConfigs.kind,
      baseUrl: schema.runtimeConfigs.baseUrl,
      model: schema.runtimeConfigs.model,
      active: schema.runtimeConfigs.active,
    })
    .from(schema.runtimeConfigs)
    .where(eq(schema.runtimeConfigs.ownerEmail, ownerEmail));
  return rows.map(normalizeActive);
}

/**
 * Load ONE saved runtime_configs row for one owner by id — mirrors
 * `loadOwnerRuntimeRows`, filtered to a single id (production default).
 * Returns undefined when no row with that id exists for THIS owner (wrong id
 * or a different owner's row — the two are indistinguishable on purpose, a
 * scoped lookup must never leak whether an id exists under someone else's
 * account). Returned regardless of `kind` — callers that must never treat a
 * claude-code-kind row as a real endpoint (the brain runtime-override paths,
 * `server/brain/brain-model.ts` / `brain-runtime.ts`) check `row.kind`
 * themselves so each can report its own specific rejection reason.
 */
export async function resolveOwnerRuntimeRow(
  ownerEmail: string,
  id: string,
): Promise<OwnerRuntimeRow | undefined> {
  const { getDb, schema } = await import("../../db/index.js");
  const [row] = await getDb()
    .select({
      id: schema.runtimeConfigs.id,
      name: schema.runtimeConfigs.name,
      kind: schema.runtimeConfigs.kind,
      baseUrl: schema.runtimeConfigs.baseUrl,
      model: schema.runtimeConfigs.model,
      active: schema.runtimeConfigs.active,
    })
    .from(schema.runtimeConfigs)
    .where(
      and(
        eq(schema.runtimeConfigs.id, id),
        eq(schema.runtimeConfigs.ownerEmail, ownerEmail),
      ),
    )
    .limit(1);
  return row ? normalizeActive(row) : undefined;
}

/** {@link resolveRuntimeRowById}'s result — the row plus its real owner. */
export interface RuntimeRowWithOwner extends OwnerRuntimeRow {
  ownerEmail: string;
}

/**
 * Resolve a runtime_configs row by id ALONE — no owner filter — for the
 * brain's own GLOBAL engine choice (`server/brain/brain-runtime.ts`'s
 * `getBrainRuntimeSelection`). That setting is a single admin-level value
 * every brain turn shares regardless of which identity dispatched it; unlike
 * {@link resolveOwnerRuntimeRow}'s per-DAG-node routing (where the ownership
 * check protects a real per-user cost/API-key boundary), scoping this lookup
 * to the CALLING identity would make the global setting only ever resolve
 * for whichever single owner happens to own that row — every other identity
 * silently falls back to Claude regardless of what the setting says (the
 * exact bug this fixes: a dispatch under a second real identity silently ran
 * on claude-sonnet-5 instead of the configured Aliyun runtime).
 */
export async function resolveRuntimeRowById(
  id: string,
): Promise<RuntimeRowWithOwner | undefined> {
  const { getDb, schema } = await import("../../db/index.js");
  const [row] = await getDb()
    .select({
      id: schema.runtimeConfigs.id,
      name: schema.runtimeConfigs.name,
      kind: schema.runtimeConfigs.kind,
      baseUrl: schema.runtimeConfigs.baseUrl,
      model: schema.runtimeConfigs.model,
      active: schema.runtimeConfigs.active,
      ownerEmail: schema.runtimeConfigs.ownerEmail,
    })
    .from(schema.runtimeConfigs)
    .where(eq(schema.runtimeConfigs.id, id))
    .limit(1);
  return row ? normalizeActive(row) : undefined;
}

/**
 * Resolve a matched row's real API key (production default) — the SAME
 * secret `save-runtime-config` writes and `activate-runtime` /
 * `test-runtime-config` read, via `runtimeApiKeySecretKey`. Local vLLM/LM
 * Studio rows never configure one; `VllmExecutor` falls through to its own
 * placeholder when this resolves to undefined. Exported so
 * `server/brain/brain-runtime.ts` can resolve the SAME secret for a brain
 * runtime-override selection instead of duplicating this lookup.
 */
export async function resolveRuntimeConfigApiKey(
  row: OwnerRuntimeRow,
  ownerEmail: string,
): Promise<string | undefined> {
  const secret = await readAppSecret({
    key: runtimeApiKeySecretKey(row.id),
    scope: "user",
    scopeId: ownerEmail,
  });
  return secret?.value || undefined;
}

export interface RoutingRuntimeExecutorDeps {
  /** Injectable for tests; production loads live runtime_configs rows. */
  loadRows?: (ownerEmail: string) => Promise<OwnerRuntimeRow[]>;
  /** Injectable for tests; production reads the row's real saved secret. */
  resolveApiKey?: (
    row: OwnerRuntimeRow,
    ownerEmail: string,
  ) => Promise<string | undefined>;
  /** Injectable for tests; production builds a real VllmExecutor. */
  vllmFor?: (cfg: VllmExecutorConfig) => RuntimeExecutor;
  /** Injectable for tests; production falls back to a real RemoteApiExecutor. */
  remoteApi?: RuntimeExecutor;
}

/**
 * The EXECUTE-stage `RuntimeExecutor` V3Dispatcher binds ONCE and reuses for
 * every node of every run (`server/plugins/v3-reconciler.ts`). Per node, it
 * consults the run owner's LIVE `runtime_configs` rows and routes to the
 * active/explicit one, or falls back to `RemoteApiExecutor` unchanged.
 */
export class RoutingRuntimeExecutor implements RuntimeExecutor {
  readonly kind = "routing";
  private readonly loadRows: (ownerEmail: string) => Promise<OwnerRuntimeRow[]>;
  private readonly resolveApiKeyFor: (
    row: OwnerRuntimeRow,
    ownerEmail: string,
  ) => Promise<string | undefined>;
  private readonly vllmFor: (cfg: VllmExecutorConfig) => RuntimeExecutor;
  private readonly remoteApi: RuntimeExecutor;

  constructor(deps: RoutingRuntimeExecutorDeps = {}) {
    this.loadRows = deps.loadRows ?? loadOwnerRuntimeRows;
    this.resolveApiKeyFor = deps.resolveApiKey ?? resolveRuntimeConfigApiKey;
    this.vllmFor = deps.vllmFor ?? ((cfg) => new VllmExecutor(cfg));
    this.remoteApi = deps.remoteApi ?? new RemoteApiExecutor();
  }

  async run(ctx: RuntimeExecCtx): Promise<RuntimeExecResult> {
    const rows = ctx.ownerEmail
      ? await this.loadRows(ctx.ownerEmail).catch(() => [] as OwnerRuntimeRow[])
      : [];
    const row = selectRuntimeRoute(ctx.node, rows);
    if (!row) return this.remoteApi.run(ctx);

    const apiKey = await this.resolveApiKeyFor(row, ctx.ownerEmail).catch(
      () => undefined,
    );
    return this.vllmFor({ baseUrl: row.baseUrl, model: row.model, apiKey }).run(
      ctx,
    );
  }
}
