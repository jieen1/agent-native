// Brain runtime-override resolution — lets the brain's model setting (the SAME
// global `BRAIN_MODEL_KEY` setting brain-model.ts already owns) point at a
// saved `runtime_configs` row (an owner's openai-compatible/vllm endpoint,
// e.g. an Aliyun/DashScope deployment) instead of a Claude model id. This is
// ADDITIVE: when the saved value is a plain Claude id (or unset), resolution
// is byte-identical to `getBrainModel()` — see the "claude" variant below.
//
// Mirrors `routing-runtime-executor.ts`'s "route a DAG node to a saved
// runtime_configs row" solution (task #85/#89) for this DIFFERENT seam: the
// brain's OWN turn-engine choice rather than a per-node EXECUTE-stage choice.
// Reuses the SAME row lookup + secret resolution so both seams agree on what
// a "real" runtime_configs row is (never claude-code kind, must have a
// baseUrl + model to drive a real endpoint).

import {
  resolveRuntimeRowById,
  resolveRuntimeConfigApiKey,
  type RuntimeRowWithOwner,
} from "../runtime/executors/routing-runtime-executor.js";
import {
  getBrainModel,
  getRawBrainModelSetting,
  parseRuntimeModelSelector,
} from "./brain-model.js";

/**
 * The brain's resolved turn-engine choice for one owner:
 *   - "claude" — the existing Claude-model path, completely unchanged.
 *   - "runtime" — a saved, valid, owned, non-claude-code runtime_configs row
 *     with both baseUrl and model set. The brain should route this turn
 *     through `runSdkBrainTurn`'s `runtimeOverride`, regardless of Claude
 *     Code login state.
 *   - "runtime-unresolved" — a `runtime:<id>` override IS saved but no longer
 *     resolves (row deleted, wrong kind, or missing baseUrl/model). Callers
 *     MUST surface this loudly (mirrors the harness-degradation invariant,
 *     04 §7) and then fall through to the pre-existing CC-login-based
 *     fallback — a broken saved selection must never block the brain.
 */
export type BrainRuntimeSelection =
  | { kind: "claude"; model: string }
  | {
      kind: "runtime";
      runtimeConfigId: string;
      name: string;
      baseUrl: string;
      model: string;
      apiKey?: string;
    }
  | { kind: "runtime-unresolved"; runtimeConfigId: string };

export interface BrainRuntimeSelectionDeps {
  /** Injectable for tests; production reads the raw BRAIN_MODEL_KEY setting. */
  getRawBrainModelSetting?: () => Promise<string>;
  /** Injectable for tests; production resolves the Claude-path model id. */
  getBrainModel?: () => Promise<string>;
  /**
   * Injectable for tests; production loads the row by id ALONE (no owner
   * filter — this is a global setting, not per-caller; see
   * {@link resolveRuntimeRowById}'s doc comment for why).
   */
  resolveRuntimeRowById?: (
    id: string,
  ) => Promise<RuntimeRowWithOwner | undefined>;
  /** Injectable for tests; production reads the row's real saved secret. */
  resolveApiKey?: (
    row: RuntimeRowWithOwner,
    ownerEmail: string,
  ) => Promise<string | undefined>;
}

/**
 * Resolve which engine a brain turn for `ownerEmail` should run on. Reads the
 * SAME global `BRAIN_MODEL_KEY` setting `getBrainModel()` reads; a
 * `runtime:<id>` value routes to that saved row regardless of which identity
 * is dispatching THIS turn (the setting is a single global choice, not a
 * per-owner one — see {@link resolveRuntimeRowById}), excluding claude-code
 * kind and requiring a real baseUrl + model. The row's OWN owner_email
 * resolves its saved API key (whoever configured the row owns the secret),
 * never the calling `ownerEmail`. Everything else keeps the exact existing
 * Claude resolution.
 */
export async function getBrainRuntimeSelection(
  ownerEmail: string,
  deps: BrainRuntimeSelectionDeps = {},
): Promise<BrainRuntimeSelection> {
  const readRaw = deps.getRawBrainModelSetting ?? getRawBrainModelSetting;
  const readModel = deps.getBrainModel ?? getBrainModel;
  const readRow = deps.resolveRuntimeRowById ?? resolveRuntimeRowById;
  const readApiKey = deps.resolveApiKey ?? resolveRuntimeConfigApiKey;

  let raw = "";
  try {
    raw = await readRaw();
  } catch {
    raw = "";
  }

  const runtimeConfigId = parseRuntimeModelSelector(raw);
  if (!runtimeConfigId) {
    return { kind: "claude", model: await readModel() };
  }

  let row: RuntimeRowWithOwner | undefined;
  try {
    row = await readRow(runtimeConfigId);
  } catch {
    row = undefined;
  }

  if (!row || row.kind === "claude-code" || !row.baseUrl || !row.model) {
    return { kind: "runtime-unresolved", runtimeConfigId };
  }

  let apiKey: string | undefined;
  try {
    apiKey = await readApiKey(row, row.ownerEmail);
  } catch {
    apiKey = undefined;
  }

  return {
    kind: "runtime",
    runtimeConfigId,
    name: row.name,
    baseUrl: row.baseUrl,
    model: row.model,
    apiKey,
  };
}
