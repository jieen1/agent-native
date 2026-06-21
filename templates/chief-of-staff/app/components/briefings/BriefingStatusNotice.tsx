import {
  IconAlertTriangle,
  IconCircleCheck,
  IconClockExclamation,
} from "@tabler/icons-react";
import type { BriefingSource, BriefingStatus } from "@shared/types";
import {
  briefingNoticeKind,
  summarizeSourceProblems,
} from "@/lib/briefing-notice";

interface BriefingStatusNoticeProps {
  status: BriefingStatus;
  sources: BriefingSource[];
}

/**
 * A single banner at the top of a briefing that makes the overall outcome
 * legible (§1.5.19 negative/边界 UX): a partial or failed compile says exactly
 * which sources fell short, and an all-ok-but-empty briefing says plainly that
 * nothing needs attention rather than showing bare empty sections. Returns null
 * for a clean `complete` briefing that has content (the sections speak for it).
 *
 * The whether/what decision is pure (`@/lib/briefing-notice`) and unit-tested;
 * this component only maps the decision to a styled banner.
 */
export function BriefingStatusNotice({
  status,
  sources,
}: BriefingStatusNoticeProps) {
  const kind = briefingNoticeKind(status, sources);
  if (kind === "none") return null;

  const problems = summarizeSourceProblems(sources);

  if (kind === "failed") {
    return (
      <div
        role="status"
        className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
      >
        <IconAlertTriangle className="mt-0.5 size-4 shrink-0" />
        <p>
          This briefing couldn&apos;t be compiled
          {problems ? <> — {problems}.</> : "."} Try compiling again once the
          apps are reachable.
        </p>
      </div>
    );
  }

  if (kind === "partial") {
    return (
      <div
        role="status"
        className="flex items-start gap-2.5 rounded-lg border border-amber-600/30 bg-amber-600/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400"
      >
        <IconClockExclamation className="mt-0.5 size-4 shrink-0" />
        <p>
          Some sources didn&apos;t come through
          {problems ? <> — {problems}.</> : "."} What did arrive is below.
        </p>
      </div>
    );
  }

  // kind === "all-clear"
  return (
    <div
      role="status"
      className="flex items-start gap-2.5 rounded-lg border border-emerald-600/30 bg-emerald-600/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-400"
    >
      <IconCircleCheck className="mt-0.5 size-4 shrink-0" />
      <p>You&apos;re all clear — nothing needs your attention today.</p>
    </div>
  );
}
