// Brain model override (the model the orchestrator brain's `claude -p` child
// runs as). It is a saved global setting, so the model is switched from the UI
// without code. startBrainTurn threads `--model <id>` into the claude argv
// (right after `-p <message>`); when no override is saved, DEFAULT_BRAIN_MODEL
// (Sonnet 5 1M) is used — the brain never silently rides the CLI default.
//
// The accepted-id list is the set of model ids the local `claude` CLI accepts
// (proven against the an-orchestrator container). `set-brain-model` validates
// against it so a typo can't wedge every brain turn with an "unknown model"
// failure. Mirrors server/queue/brain-concurrency.ts in shape.

import { getSetting, putSetting } from "@agent-native/core/settings";

/** Settings key holding the brain model override. */
export const BRAIN_MODEL_KEY = "brain-model";

/**
 * Settings key controlling which model tier is permitted for the CC subscription
 * brain. Defaults to "sonnet" (Opus/Fable blocked); can be relaxed to "all".
 */
export const BRAIN_MODEL_TIER_KEY = "brain-model-tier";

/** Tier values: "sonnet" = Sonnet 5 only; "all" = full model list. */
export type BrainModelTier = "sonnet" | "all";

/** Premium models blocked under the default "sonnet" tier (Opus + Fable). */
const RESTRICTED_MODELS = new Set([
  "claude-opus-4-8",
  "claude-opus-4-8[1m]",
  "claude-fable-5",
]);

/** Return the subset of ACCEPTED_BRAIN_MODELS allowed for the given tier. */
export function getAllowedBrainModels(
  tier: BrainModelTier,
): readonly string[] {
  if (tier === "all") return ACCEPTED_BRAIN_MODELS;
  return ACCEPTED_BRAIN_MODELS.filter((m) => !RESTRICTED_MODELS.has(m));
}

/** True if `model` is allowed under `tier`. */
export function isModelAllowedInTier(
  model: string,
  tier: BrainModelTier,
): boolean {
  if (tier === "all") return true;
  return !RESTRICTED_MODELS.has(model);
}

/**
 * Read the saved model tier. Defaults to "sonnet" (Opus blocked) when unset.
 */
export async function getBrainModelTier(): Promise<BrainModelTier> {
  let raw: unknown = null;
  try {
    raw = await getSetting(BRAIN_MODEL_TIER_KEY);
  } catch {
    return "sonnet";
  }
  const value =
    raw && typeof raw === "object" ? (raw as { tier?: unknown }).tier : raw;
  if (value === "all") return "all";
  return "sonnet";
}

/** Persist the model tier. */
export async function setBrainModelTier(
  tier: BrainModelTier,
): Promise<BrainModelTier> {
  await putSetting(BRAIN_MODEL_TIER_KEY, { tier });
  return tier;
}

/**
 * The default brain model when no override is saved: Sonnet 5 with the 1M
 * context window (`claude-sonnet-5[1m]` verified accepted by the container's
 * `claude` CLI on 2026-07-11).
 */
export const DEFAULT_BRAIN_MODEL = "claude-sonnet-5[1m]";

/**
 * The model ids the local `claude` CLI accepts (verified against the
 * an-orchestrator container). Deliberately short: Sonnet 5 (1M) is the
 * default; Opus 4.8 and Fable 5 are the premium options gated behind the
 * "all" tier. Concrete ids carry the `[1m]` context-window suffix where the
 * CLI exposes the 1M window. The stream-json init `model` echoes the resolved
 * id (e.g. `claude-sonnet-5[1m]`).
 */
export const ACCEPTED_BRAIN_MODELS = [
  "claude-sonnet-5[1m]",
  "claude-opus-4-8",
  "claude-opus-4-8[1m]",
  "claude-fable-5",
] as const;

export type BrainModelId = (typeof ACCEPTED_BRAIN_MODELS)[number];

/** A user-facing label for each accepted id (for the Select). */
export const BRAIN_MODEL_LABELS: Record<string, string> = {
  "": "Sonnet 5 (1M) — default",
  "claude-sonnet-5[1m]": "Sonnet 5 (1M)",
  "claude-opus-4-8": "Opus 4.8",
  "claude-opus-4-8[1m]": "Opus 4.8 (1M)",
  "claude-fable-5": "Fable 5",
};

/** True if `id` is an accepted brain model id/alias. */
export function isAcceptedBrainModel(id: string): id is BrainModelId {
  return (ACCEPTED_BRAIN_MODELS as readonly string[]).includes(id);
}

/**
 * Read the saved brain model override. When nothing (or a no-longer-accepted
 * id) is saved, fall back to DEFAULT_BRAIN_MODEL — the brain always runs a
 * known model rather than whatever the CLI defaults to. A throwing getSetting
 * degrades to the default rather than failing the turn.
 */
export async function getBrainModel(): Promise<string> {
  let raw: unknown = null;
  try {
    raw = await getSetting(BRAIN_MODEL_KEY);
  } catch {
    return DEFAULT_BRAIN_MODEL;
  }
  const value =
    raw && typeof raw === "object" ? (raw as { model?: unknown }).model : raw;
  if (typeof value !== "string") return DEFAULT_BRAIN_MODEL;
  const trimmed = value.trim();
  if (!trimmed || !isAcceptedBrainModel(trimmed)) return DEFAULT_BRAIN_MODEL;
  return trimmed;
}

/**
 * Persist a new brain model override (validated against the accepted list).
 * Pass an empty string / "default" intent by deleting — here we store the value
 * verbatim; an empty/invalid value is rejected by the action layer before this.
 */
export async function setBrainModel(model: string): Promise<string> {
  const trimmed = model.trim();
  if (!isAcceptedBrainModel(trimmed)) {
    throw new Error(`Unsupported brain model: ${trimmed}`);
  }
  await putSetting(BRAIN_MODEL_KEY, { model: trimmed });
  return trimmed;
}
