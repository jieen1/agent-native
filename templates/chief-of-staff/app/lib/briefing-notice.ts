import type { BriefingSource, BriefingStatus } from "@shared/types";

/**
 * Pure decision logic for the briefing status notice (§1.5.19), split out from
 * the component so it is unit-testable without a DOM. The component renders the
 * banner; these functions decide *whether* and *what* it says.
 */

/** Which banner (if any) a briefing's outcome warrants. */
export type BriefingNoticeKind = "failed" | "partial" | "all-clear" | "none";

/**
 * Decide which notice to show:
 *   - `failed`    — the compile produced nothing usable.
 *   - `partial`   — some sources came through, others failed/timed out/skipped.
 *   - `all-clear` — every source was ok but none reported anything to handle.
 *   - `none`      — a normal complete briefing with content (sections speak).
 */
export function briefingNoticeKind(
  status: BriefingStatus,
  sources: BriefingSource[],
): BriefingNoticeKind {
  if (status === "failed") return "failed";
  if (status === "partial") return "partial";
  if (status === "complete" && sources.length > 0) {
    const anyContent = sources.some(
      (s) => s.status === "ok" && s.responseText.trim().length > 0,
    );
    if (!anyContent) return "all-clear";
  }
  return "none";
}

/**
 * Human-readable summary of which sources fell short, e.g.
 * "couldn't reach mail; calendar timed out; analytics not connected".
 * Returns null when no source had a problem.
 */
export function summarizeSourceProblems(
  sources: BriefingSource[],
): string | null {
  const byStatus = (status: BriefingSource["status"]): string[] =>
    sources.filter((s) => s.status === status).map((s) => s.app);

  const failed = byStatus("error");
  const timedOut = byStatus("timeout");
  const skipped = byStatus("skipped");

  const parts: string[] = [];
  if (failed.length) parts.push(`couldn't reach ${failed.join(", ")}`);
  if (timedOut.length) parts.push(`${timedOut.join(", ")} timed out`);
  if (skipped.length) parts.push(`${skipped.join(", ")} not connected`);
  return parts.length ? parts.join("; ") : null;
}
