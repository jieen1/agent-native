// Brain model override (the model the orchestrator brain's `claude -p` child
// runs as). It is a saved global setting, so the model is switched from the UI
// without code. When set, startBrainTurn threads `--model <id>` into the claude
// argv (right after `-p <message>`); when unset, the CLI uses its default model.
//
// The accepted-id list is the set of model ids + aliases the local `claude` CLI
// accepts (proven against the an-orchestrator container). `set-brain-model`
// validates against it so a typo can't wedge every brain turn with an "unknown
// model" failure. Mirrors server/queue/brain-concurrency.ts in shape.

import { getSetting, putSetting } from "@agent-native/core/settings";

/** Settings key holding the brain model override. */
export const BRAIN_MODEL_KEY = "brain-model";

/**
 * The default brain model used when no override is saved. Changing this
 * upgrades all new sessions to the specified model without requiring users to
 * explicitly pick one.
 */
export const DEFAULT_BRAIN_MODEL = "claude-sonnet-5";

/**
 * Settings key controlling which model tier is permitted for the CC subscription
 * brain. Defaults to "sonnet" (Opus blocked); can be relaxed to "all".
 */
export const BRAIN_MODEL_TIER_KEY = "brain-model-tier";

/** Tier values: "sonnet" = Sonnet + Haiku only; "all" = full model list. */
export type BrainModelTier = "sonnet" | "all";

const OPUS_MODELS = new Set([
  "claude-opus-4-8",
  "claude-opus-4-8[1m]",
  "claude-opus-4-7[1m]",
  "claude-opus-4-6[1m]",
  "claude-opus-4-5",
  "opus",
  "opus[1m]",
]);

/** Return the subset of ACCEPTED_BRAIN_MODELS allowed for the given tier. */
export function getAllowedBrainModels(
  tier: BrainModelTier,
): readonly string[] {
  if (tier === "all") return ACCEPTED_BRAIN_MODELS;
  return ACCEPTED_BRAIN_MODELS.filter((m) => !OPUS_MODELS.has(m));
}

/** True if `model` is allowed under `tier`. */
export function isModelAllowedInTier(
  model: string,
  tier: BrainModelTier,
): boolean {
  if (tier === "all") return true;
  return !OPUS_MODELS.has(model);
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
 * The model ids + aliases the local `claude` CLI accepts (verified against the
 * an-orchestrator container). Concrete ids carry the `[1m]` context-window
 * suffix where the CLI exposes the 1M window; the bare aliases (`opus`,
 * `sonnet`, `haiku`, `default`) resolve to the CLI's current mapping. The
 * stream-json init `model` echoes the resolved id (e.g. `claude-opus-4-8[1m]`).
 */
export const ACCEPTED_BRAIN_MODELS = [
  "claude-opus-4-8",
  "claude-opus-4-8[1m]",
  "claude-opus-4-7[1m]",
  "claude-opus-4-6[1m]",
  "claude-opus-4-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5[1m]",
  "claude-haiku-4-5",
  // Aliases the CLI resolves to a concrete id.
  "opus",
  "sonnet",
  "haiku",
  "opus[1m]",
  "default",
] as const;

export type BrainModelId = (typeof ACCEPTED_BRAIN_MODELS)[number];

/** A user-facing label for each accepted id (for the Select). */
export const BRAIN_MODEL_LABELS: Record<string, string> = {
  "": "CLI default",
  default: "CLI default (alias)",
  "claude-opus-4-8": "Opus 4.8",
  "claude-opus-4-8[1m]": "Opus 4.8 (1M)",
  "claude-opus-4-7[1m]": "Opus 4.7 (1M)",
  "claude-opus-4-6[1m]": "Opus 4.6 (1M)",
  "claude-opus-4-5": "Opus 4.5",
  "claude-sonnet-5": "Sonnet 5",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-sonnet-4-5[1m]": "Sonnet 4.5 (1M)",
  "claude-haiku-4-5": "Haiku 4.5",
  opus: "Opus (alias)",
  sonnet: "Sonnet (alias)",
  haiku: "Haiku (alias)",
  "opus[1m]": "Opus 1M (alias)",
};

/** True if `id` is an accepted brain model id/alias. */
export function isAcceptedBrainModel(id: string): id is BrainModelId {
  return (ACCEPTED_BRAIN_MODELS as readonly string[]).includes(id);
}

/**
 * Read the saved brain model override, falling back to DEFAULT_BRAIN_MODEL
 * when none is explicitly set. Returns null only when the stored value is the
 * sentinel "default" (meaning: use CLI default without pinning a model id).
 * A throwing getSetting degrades to the built-in default rather than failing.
 */
export async function getBrainModel(): Promise<string | null> {
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
  // Explicit "clear" — user wants bare CLI default, no model flag.
  if (trimmed === "" || trimmed === "default") return null;
  if (!isAcceptedBrainModel(trimmed)) return DEFAULT_BRAIN_MODEL;
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
