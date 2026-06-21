/**
 * Deep-link extraction for briefing sources (docs/IMPLEMENTATION_PLAN.md
 * §1.5.12).
 *
 * A sibling app's agent replies with free text that may reference objects by
 * URL — either as a markdown link `[label](https://…)` or a bare
 * `https://…`. We pull those out into `BriefingSource.deepLinks` so the panel
 * can render "Open in <app>" buttons that jump straight back to the right
 * object in the source app.
 *
 * The rules (all from §1.5.12), in order:
 *   1. Collect markdown-link targets ∪ bare URLs from the reply text.
 *   2. Also collect app-relative paths (`/threads/abc`) so an agent that
 *      forgets to fully-qualify a link is still usable; complete them against
 *      the source app's base URL.
 *   3. Keep ONLY links whose origin equals the source app's own origin — never
 *      surface a link to some other host (a `mail` source must not produce a
 *      `calendar` link, and certainly not an arbitrary external one).
 *   4. De-duplicate, preserving first-seen order.
 *   5. Nothing extractable → `[]` (the panel then shows plain text, no dead
 *      button).
 *
 * Pure + deterministic so it unit-tests directly. The only inputs are the reply
 * text and the source app's discovered base URL.
 */

/** Markdown link target: `[label](https://…)` → captures the URL. */
const MARKDOWN_LINK = /\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;

/** A bare absolute URL anywhere in the text. */
const BARE_URL = /https?:\/\/[^\s<>()[\]]+/g;

/**
 * An app-relative path target inside a markdown link: `[label](/threads/abc)`.
 * Only rooted ("/…") paths qualify, so we don't sweep up stray "(text)".
 */
const MARKDOWN_RELATIVE = /\[[^\]]*\]\((\/[^)\s]+)\)/g;

/** Strip a single trailing punctuation char a sentence often leaves on a URL. */
function trimTrailingPunctuation(url: string): string {
  return url.replace(/[.,;:!?]+$/, "");
}

/** The origin (scheme + host + port) of a URL, or null if it cannot be parsed. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Extract the deep links for one source from its `responseText`, scoped to the
 * source app's own origin. `appBaseUrl` is the discovered agent URL for that
 * app (e.g. "http://localhost:8110"); relative links are completed against it
 * and absolute links are kept only if they share its origin.
 *
 * Returns a de-duplicated list of fully-qualified URLs in first-seen order, or
 * `[]` when nothing app-scoped is found.
 */
export function extractDeepLinks(
  responseText: string,
  appBaseUrl: string,
): string[] {
  const appOrigin = originOf(appBaseUrl);
  if (!appOrigin || !responseText) return [];

  const seen = new Set<string>();
  const out: string[] = [];

  const add = (raw: string) => {
    const cleaned = trimTrailingPunctuation(raw);
    let absolute: string;
    try {
      // Resolves both absolute URLs (base ignored) and rooted relative paths
      // (resolved against the app base) to a fully-qualified URL.
      absolute = new URL(cleaned, appBaseUrl).toString();
    } catch {
      return;
    }
    // Keep only links that point back at the source app itself (§1.5.12).
    if (originOf(absolute) !== appOrigin) return;
    if (seen.has(absolute)) return;
    seen.add(absolute);
    out.push(absolute);
  };

  // Markdown links first so a `[label](url)` URL keeps its intended order ahead
  // of any later bare occurrence of the same href.
  for (const m of responseText.matchAll(MARKDOWN_LINK)) add(m[1]);
  for (const m of responseText.matchAll(MARKDOWN_RELATIVE)) add(m[1]);
  for (const m of responseText.matchAll(BARE_URL)) add(m[0]);

  return out;
}
