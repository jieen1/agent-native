// Per-runtime model-list helpers (DESIGN §8.3 item4). A single OpenAI-compatible
// endpoint (vLLM, LM Studio) can serve several models; the optional additive
// `runtime_configs.models` JSON column stores those ids so the per-node
// ModelPicker can offer each WITHOUT registering a custom engine (§8.5.1).
//
// These are PURE (no IO) so they live in `shared/` — imported by the server
// actions `list-runtime-configs` (read) / `save-runtime-config` (write), the
// editor ModelPicker (expand), and tests. `model` stays the activation default;
// `models` only widens the picker.

/** Parse the JSON `models` column into a clean string array (never throws). */
export function parseModelList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return dedupe(
      parsed
        .filter((m): m is string => typeof m === "string")
        .map((m) => m.trim())
        .filter((m) => m !== ""),
    );
  } catch {
    return [];
  }
}

/** Serialize a model list to the JSON column form; empty → null (use `model`). */
export function serializeModelList(
  models: readonly string[] | undefined,
): string | null {
  const clean = dedupe(
    (models ?? []).map((m) => m.trim()).filter((m) => m !== ""),
  );
  return clean.length > 0 ? JSON.stringify(clean) : null;
}

/**
 * The union of a runtime's activation default `model` and its extra `models`,
 * de-duped, order-preserving (default first). This is exactly the set the
 * per-node picker turns into one option per model.
 */
export function pickerModelsFor(
  model: string | null | undefined,
  models: readonly string[] | undefined,
): string[] {
  const all: string[] = [];
  if (model && model.trim() !== "") all.push(model.trim());
  for (const m of models ?? []) {
    if (m && m.trim() !== "") all.push(m.trim());
  }
  return dedupe(all);
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}
