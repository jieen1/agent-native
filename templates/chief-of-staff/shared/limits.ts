/**
 * Size limits for briefing fan-out, shared by the `compile-briefing` action,
 * the `runFanout` merge step, and their tests. Named constants so the byte-cap
 * acceptance (docs/IMPLEMENTATION_PLAN.md §1.5.6 / §1.5.18) can reference the
 * exact same numbers the production code enforces.
 *
 * Rationale: a single chatty sibling agent must not be able to blow up a
 * briefing row (token cost + DB size). Each source's `responseText` is capped
 * at MAX_PER_SOURCE_CHARS; the whole serialized `sourcesJson` is capped at
 * MAX_BRIEFING_BYTES as a final backstop. Over-limit content is truncated and
 * marked with TRUNCATION_MARKER so the panel/agent can see it was cut.
 */

/** Per-source `responseText` character cap; longer replies are truncated + marked. */
export const MAX_PER_SOURCE_CHARS = 8_000;

/** Whole-briefing `sourcesJson` byte cap (UTF-8); a final backstop after per-source caps. */
export const MAX_BRIEFING_BYTES = 64_000;

/** Appended to any value that was truncated, so readers can tell it was cut. */
export const TRUNCATION_MARKER = "\n\n[…truncated]";

/**
 * Truncate `text` to at most MAX_PER_SOURCE_CHARS characters, appending
 * TRUNCATION_MARKER when (and only when) a cut actually happened. Pure +
 * deterministic so it can be unit-tested directly against a large input.
 */
export function truncateSourceText(
  text: string,
  max: number = MAX_PER_SOURCE_CHARS,
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = text.slice(0, max);
  return { text: `${head}${TRUNCATION_MARKER}`, truncated: true };
}

/** UTF-8 byte length of a string (Buffer is always available in the Node runtime). */
export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
