/**
 * Shared types for the Chief-of-Staff app, used by both actions (server) and
 * the frontend. See docs/CHIEF_OF_STAFF_DESIGN.md §5.
 */

/** The kinds of briefing a compile run can produce. */
export const BRIEFING_KINDS = ["morning", "evening", "adhoc"] as const;
export type BriefingKind = (typeof BRIEFING_KINDS)[number];

/** Lifecycle status of a briefing row. */
export const BRIEFING_STATUSES = [
  "compiling",
  "complete",
  "partial",
  "failed",
] as const;
export type BriefingStatus = (typeof BRIEFING_STATUSES)[number];

/** Per-source status when a single app's fan-out leg resolves. */
export const BRIEFING_SOURCE_STATUSES = [
  "ok",
  "error",
  "skipped",
  "timeout",
] as const;
export type BriefingSourceStatus = (typeof BRIEFING_SOURCE_STATUSES)[number];

/**
 * One element of a briefing's `sourcesJson` — the result of asking a single
 * sibling app's agent for "what needs my attention today". Populated by
 * `compile-briefing` fan-out in Phase B2; the B1 schema/actions already carry
 * the type so list/get readers and the panel agree on shape.
 */
export interface BriefingSource {
  /** Target app id (e.g. "mail", "calendar"). */
  app: string;
  /** The actual natural-language question sent to that app's agent. */
  prompt: string;
  /** The agent's raw reply text (may contain deep-link markdown). */
  responseText: string;
  /** Fully-qualified URLs extracted from `responseText`. */
  deepLinks: string[];
  /** How this source's fan-out leg resolved. */
  status: BriefingSourceStatus;
  /** Error detail when `status === "error"`. */
  error?: string;
  /** Wall-clock latency of the fan-out call in milliseconds. */
  latencyMs: number;
}

/** A briefing summary as returned by list/get actions. */
export interface BriefingSummary {
  id: string;
  briefingDate: string;
  kind: BriefingKind;
  title: string;
  summaryMd: string;
  status: BriefingStatus;
  focus: string | null;
  createdAt: string;
  updatedAt: string;
  ownerEmail: string;
}
