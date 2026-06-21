/**
 * Client-safe meta-tag formatting helpers for the public briefing page.
 *
 * Keep this module free of server imports — route `meta` functions run in the
 * browser too, so anything imported here ships in the client bundle. Mirrors
 * templates/plan/shared/plan-meta-format.ts.
 */

/**
 * Build a ~160-char meta description from a briefing's polished summary. The
 * summary may contain light markdown (headings, links); strip the most common
 * markup so the unfurl description reads as plain prose.
 */
export function buildBriefingMetaDescription(summaryMd: string): string {
  const plain = summaryMd
    .replace(/^#{1,6}\s+/gm, "") // ATX heading markers
    .replace(/\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, "$1") // [text](url) → text
    .replace(/[*_`>]/g, "") // inline emphasis / code / quote markers
    .replace(/\s+/g, " ")
    .trim();

  if (plain.length === 0) {
    return "A cross-app daily briefing compiled by Chief of Staff.";
  }
  if (plain.length <= 160) return plain;
  // Truncate at the last space before the 157-char mark so the ellipsis keeps
  // the total at/under 160 characters.
  const cut = plain.lastIndexOf(" ", 157);
  return `${plain.slice(0, cut > 0 ? cut : 157)}…`;
}
