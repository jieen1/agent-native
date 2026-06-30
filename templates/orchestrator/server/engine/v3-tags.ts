// V3 Tags helper — design §16 (opaque JSONB, cross-app traceability)

/**
 * Well-known tag keys for cross-app traceability.
 * Orchestrator logic does NOT interpret tag contents; these are documented
 * conventions so callers know what to set.
 */
export interface V3Tags {
  // ── Source tracking (A2A) ─────────────────────────────────────────
  /** App that originated this run. */
  source_app?: string;
  /** Run ID in the originating app. */
  source_run_id?: string;
  /** Node ID within the originating run. */
  source_node_id?: string;

  // ── Business semantics ────────────────────────────────────────────
  project_id?: string;
  work_item_id?: string;
  user_id?: string;

  // ── Custom keys (opaque, passed through unchanged) ────────────────
  [key: string]: string | undefined;
}

/**
 * Merge extraTags over sourceTags.
 * Extra keys override source keys with the same name.
 * Returns a new object (never mutates inputs).
 */
export function mergeTags(
  sourceTags: V3Tags | null | undefined,
  extraTags: V3Tags | null | undefined,
): V3Tags | null {
  if (!sourceTags && !extraTags) return null;

  const merged: V3Tags = { ...sourceTags };

  if (extraTags) {
    for (const key of Object.keys(extraTags)) {
      merged[key] = extraTags[key];
    }
  }

  return merged;
}

/**
 * Validate that the given tags object has the expected shape.
 * Returns an error message string, or undefined when the shape is valid.
 *
 * Rules:
 * - Must be a plain object (not null, not an array).
 * - All values must be strings.
 */
export function validateTagsFormat(tags: unknown): string | undefined {
  if (typeof tags !== "object" || tags === null || Array.isArray(tags)) {
    return "Tags must be a plain object";
  }

  for (const [key, value] of Object.entries(tags)) {
    if (typeof key !== "string") {
      return `Tag key must be a string, got ${typeof key}`;
    }
    if (value !== undefined && value !== null && typeof value !== "string") {
      return `Tag value for "${key}" must be a string, got ${typeof value}`;
    }
  }

  return undefined;
}
