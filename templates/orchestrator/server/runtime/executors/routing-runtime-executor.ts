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
import { eq } from "drizzle-orm";

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

/** Load every saved runtime_configs row for one owner (production default). */
async function loadOwnerRuntimeRows(
  ownerEmail: string,
): Promise<OwnerRuntimeRow[]> {
  const { getDb, schema } = await import("../../db/index.js");
  const rows = await getDb()
    .select({
      id: schema.runtimeConfigs.id,
      kind: schema.runtimeConfigs.kind,
      baseUrl: schema.runtimeConfigs.baseUrl,
      model: schema.runtimeConfigs.model,
      active: schema.runtimeConfigs.active,
    })
    .from(schema.runtimeConfigs)
    .where(eq(schema.runtimeConfigs.ownerEmail, ownerEmail));
  return rows as OwnerRuntimeRow[];
}

/**
 * Resolve a matched row's real API key (production default) — the SAME
 * secret `save-runtime-config` writes and `activate-runtime` /
 * `test-runtime-config` read, via `runtimeApiKeySecretKey`. Local vLLM/LM
 * Studio rows never configure one; `VllmExecutor` falls through to its own
 * placeholder when this resolves to undefined.
 */
async function resolveRowApiKey(
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
    this.resolveApiKeyFor = deps.resolveApiKey ?? resolveRowApiKey;
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
