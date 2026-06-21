/**
 * Minimal server-side public-briefing fetcher for SSR.
 *
 * Deliberately SHALLOW: imports only getDb + schema (Drizzle) — no fan-out
 * orchestration, no h3, no client/browser deps — so this file stays safe in the
 * Nitro server bundle and never drags an SSR-hostile dependency into the build.
 * Mirrors templates/plan/server/lib/plan-meta.server.ts.
 *
 * Privacy contract (Phase C / §455): only expose a briefing's content when
 * `visibility === "public"`. Private or missing briefings return `null` so the
 * route falls back to generic meta and the CSR shell — a private briefing's
 * title or body must never appear in SSR HTML for unauthenticated fetchers
 * (link-unfurl bots are unauthenticated). This is a deliberate second, shallow
 * gate; `resolveAccess` also admits anonymous public reads, but the SSR loader
 * uses this reader to stay free of the action/HTTP surface.
 */

import { eq } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";

export interface PublicBriefingView {
  id: string;
  title: string;
  /** Agent-polished narrative (or the no-LLM digest fallback). */
  summaryMd: string;
  briefingDate: string;
  kind: string;
}

/**
 * Fetch the minimal briefing data needed to server-render a public briefing
 * page (title, summary body, date, kind) plus its meta tags.
 *
 * Returns `null` when:
 *   - the briefing does not exist
 *   - the briefing's visibility is not "public"
 *
 * Never throws — callers fall back to generic meta + the CSR shell on null.
 */
export async function fetchPublicBriefing(
  id: string,
): Promise<PublicBriefingView | null> {
  try {
    const [row] = await getDb()
      .select({
        id: schema.briefings.id,
        title: schema.briefings.title,
        summaryMd: schema.briefings.summaryMd,
        briefingDate: schema.briefings.briefingDate,
        kind: schema.briefings.kind,
        visibility: schema.briefings.visibility,
      })
      .from(schema.briefings)
      .where(eq(schema.briefings.id, id))
      .limit(1);

    if (!row || row.visibility !== "public") return null;

    return {
      id: row.id,
      title: row.title,
      summaryMd: row.summaryMd,
      briefingDate: row.briefingDate,
      kind: row.kind ?? "adhoc",
    };
  } catch {
    return null;
  }
}
