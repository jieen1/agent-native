/**
 * Pure, LLM-free helpers for assembling a briefing from its fan-out sources.
 *
 * IMPORTANT (docs/CHIEF_OF_STAFF_DESIGN.md §4 D4 / §6.1, IMPLEMENTATION_PLAN
 * §1.5.3): `deterministicDigest` is only a fallback that section-stitches the
 * raw source replies. It does NOT call an LLM. The polished narrative is
 * written separately by the Chief-of-Staff agent via `update-briefing` after
 * `compile-briefing` returns. Keeping this pure makes it unit-testable and
 * keeps the "all AI goes through the agent chat" contract intact.
 *
 * All exports here are pure functions of their inputs (the only ambient input
 * is the local clock, isolated in `todayLocalDate`), so they unit-test cleanly.
 */

import type { BriefingKind, BriefingSource, BriefingStatus } from "./types.js";

/** Local-timezone YYYY-MM-DD. Mirrors app/pages/TodayBriefingPage.tsx (§1.5.14). */
export function todayLocalDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** A human label for a briefing kind, used in default titles + headings. */
function kindTitle(kind: BriefingKind): string {
  switch (kind) {
    case "morning":
      return "Morning briefing";
    case "evening":
      return "Evening recap";
    default:
      return "Briefing";
  }
}

/** Default title for a freshly-compiled briefing, e.g. "Morning briefing — 2026-06-21". */
export function defaultTitle(kind: BriefingKind, briefingDate: string): string {
  return `${kindTitle(kind)} — ${briefingDate}`;
}

/**
 * Derive the briefing's overall status from its per-source outcomes:
 *   - no sources, or every source failed/timed out/was skipped → "failed"
 *   - every source ok                                          → "complete"
 *   - some ok, some not                                        → "partial"
 * "skipped" sources count as not-ok but do not by themselves fail a briefing
 * that has at least one ok source.
 */
export function deriveStatus(sources: BriefingSource[]): BriefingStatus {
  if (sources.length === 0) return "failed";
  const okCount = sources.filter((s) => s.status === "ok").length;
  if (okCount === 0) return "failed";
  if (okCount === sources.length) return "complete";
  return "partial";
}

/** Pretty-print a source's status for the fallback digest headings. */
function statusLabel(status: BriefingSource["status"]): string {
  switch (status) {
    case "ok":
      return "";
    case "timeout":
      return " (timed out)";
    case "error":
      return " (unavailable)";
    case "skipped":
      return " (not connected)";
    default:
      return "";
  }
}

/** Title-case an app id for a section heading ("mail" → "Mail"). */
function appHeading(appId: string): string {
  if (!appId) return "Source";
  return appId.charAt(0).toUpperCase() + appId.slice(1);
}

/**
 * No-LLM fallback summary: one markdown section per source with its raw reply.
 * The agent overwrites this with a polished `summaryMd` via `update-briefing`;
 * until then the panel still shows something useful and fully auditable.
 */
export function deterministicDigest(sources: BriefingSource[]): string {
  if (sources.length === 0) {
    return "_No sources were available for this briefing._";
  }

  const sections = sources.map((s) => {
    const heading = `## ${appHeading(s.app)}${statusLabel(s.status)}`;
    let body: string;
    if (s.status === "ok") {
      body = s.responseText.trim() || "_No items reported._";
    } else if (s.status === "skipped") {
      body = "_This app is not connected, so it was skipped._";
    } else {
      body = s.error
        ? `_Couldn't reach this app: ${s.error}_`
        : "_Couldn't reach this app._";
    }
    return `${heading}\n\n${body}`;
  });

  return sections.join("\n\n");
}
