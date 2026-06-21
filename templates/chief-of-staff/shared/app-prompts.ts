/**
 * Per-app natural-language prompts for the briefing fan-out.
 *
 * `compile-briefing` does NOT call a sibling app's action directly (that would
 * bypass the sibling agent's tool orchestration + access control). Instead it
 * sends a natural-language question to the sibling *agent*, which uses its own
 * full tool surface — under the caller's restored {userEmail, orgId} context —
 * to gather data and reply with text (including fully-qualified deep links).
 * See docs/CHIEF_OF_STAFF_DESIGN.md §3 / §4 (D1) and §6.1.
 *
 * Each prompt is deliberately constrained ("only what needs my attention",
 * "give me the link", "keep it short") to bound token growth (§3 risk table)
 * — the wider per-source char cap lives in `limits.ts`.
 */

import type { BriefingKind } from "./types.js";

/**
 * The default set of apps a briefing fans out to when the caller does not pass
 * an explicit `apps` list. Phase B2 shipped mail + calendar; Phase B3 adds
 * brain + analytics (docs/IMPLEMENTATION_PLAN.md §1.5.16 — the four selected
 * data sources). Kept here (not in the action) so settings overrides and the
 * action share one source of truth.
 */
export const DEFAULT_APPS = ["mail", "calendar", "brain", "analytics"] as const;

/** Human label for the time-of-day a briefing covers, woven into each prompt. */
function kindLabel(kind: BriefingKind): string {
  switch (kind) {
    case "morning":
      return "this morning";
    case "evening":
      return "today (an end-of-day recap)";
    default:
      return "today";
  }
}

/** The shared closing instruction every prompt ends with. */
function commonContract(): string {
  return (
    "Keep it tight: only items that need MY attention or action — skip anything " +
    "routine or already handled. For each item give one short line plus a " +
    "fully-qualified link to the object so I can open it. If there is nothing " +
    "noteworthy, say so in one sentence. Do not invent links or ids."
  );
}

/** Append a free-form focus hint when the caller passed one. */
function withFocus(base: string, focus?: string): string {
  const trimmed = focus?.trim();
  if (!trimmed) return base;
  return `${base}\n\nExtra focus for this briefing: ${trimmed}.`;
}

/**
 * Build the natural-language question for one app id. `mail` and `calendar`
 * get bespoke phrasing; any other (or future) app id gets a sensible generic
 * question. Pure + deterministic so it can be unit-tested.
 */
export function buildAppPrompt(
  appId: string,
  kind: BriefingKind = "adhoc",
  focus?: string,
): string {
  const when = kindLabel(kind);
  const tail = commonContract();

  switch (appId) {
    case "mail": {
      const base =
        `What email needs my attention ${when}? List the unread or important ` +
        `threads that actually require a reply or decision from me, most urgent ` +
        `first. For each, give the sender, a one-line gist, and a deep link to ` +
        `the thread.\n\n${tail}`;
      return withFocus(base, focus);
    }
    case "calendar": {
      const base =
        `What is on my calendar ${when} that I should be ready for? List the ` +
        `meetings and events in time order, flag anything that needs prep, a ` +
        `decision, or has a conflict, and give a deep link to each event.\n\n${tail}`;
      return withFocus(base, focus);
    }
    case "brain": {
      // Brain is a router as much as a source (docs/CHIEF_OF_STAFF_DESIGN.md §6 /
      // IMPLEMENTATION_PLAN §1.5.16). Start it on `search-everything` so it both
      // surfaces relevant indexed knowledge AND reports `federatedCoverage`
      // delegation hints. We ask it to follow those hints into the downstream
      // apps it owns and fold their answers in — the brain agent has the full
      // tool surface (including call-agent) inside its own loop, so this is the
      // "ask the agent in natural language, it self-routes" path (§3 / §6).
      const base =
        `What from our workspace knowledge needs my attention ${when}? Start by ` +
        `calling search-everything to surface the most relevant indexed ` +
        `knowledge, captures, and sources, and to read its ` +
        `federatedCoverage.delegationHints. Use those hints to decide which ` +
        `downstream apps you should also pull from, and fold the important items ` +
        `from those apps into your answer too. List what I should look at, most ` +
        `important first, with a deep link to each item.\n\n${tail}`;
      return withFocus(base, focus);
    }
    case "analytics": {
      // §1.5.13 caliber: analytics actions are metadata-only except `get-analysis`,
      // which needs an id. So the briefing contribution is: list recent
      // dashboards/analyses as links, and ONLY if a conventionally-named daily
      // metrics analysis exists, fetch it and surface its existing numbers. Never
      // run new ad-hoc queries or invent metrics for the briefing.
      const base =
        `What in analytics should I be aware of ${when}? Call list-sql-dashboards ` +
        `and list-analyses and give me the few most recently updated dashboards ` +
        `and saved analyses, most recent first, each with its deep link. If I ` +
        `maintain a saved analysis named like a daily-metrics or daily-briefing ` +
        `report, also call get-analysis on it and include its key result numbers ` +
        `(summarize resultMarkdown/resultData to a few lines). Do NOT run new ` +
        `ad-hoc queries or invent metrics — only surface dashboards, analyses, ` +
        `and results that already exist. Give a deep link to each item.\n\n${tail}`;
      return withFocus(base, focus);
    }
    default: {
      const base =
        `What in ${appId} needs my attention ${when}? Summarize the items I ` +
        `should look at, most important first, with a deep link to each.\n\n${tail}`;
      return withFocus(base, focus);
    }
  }
}
