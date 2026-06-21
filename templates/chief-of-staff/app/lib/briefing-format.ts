import type { BriefingSourceStatus, BriefingStatus } from "@shared/types";

/**
 * Presentation helpers for briefings — date formatting, status labels, and
 * badge color classes. Kept dependency-free (no date-fns) so the panel stays a
 * lean skeleton.
 */

/** Format a YYYY-MM-DD briefing date as a readable label. */
export function formatBriefingDate(date: string): string {
  // Parse as local date (no timezone shift) — the value is already a local day.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const [, y, m, d] = match;
  const parsed = new Date(Number(y), Number(m) - 1, Number(d));
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Format an ISO timestamp as a short relative-ish time label. */
export function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

interface StatusDisplay {
  label: string;
  variant: BadgeVariant;
  /** Extra classes for accent colors not covered by the base variants. */
  className?: string;
}

const BRIEFING_STATUS_DISPLAY: Record<BriefingStatus, StatusDisplay> = {
  compiling: {
    label: "Compiling",
    variant: "outline",
    className:
      "border-amber-600/30 bg-amber-600/10 text-amber-700 dark:text-amber-400",
  },
  complete: {
    label: "Complete",
    variant: "outline",
    className:
      "border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400",
  },
  partial: {
    label: "Partial",
    variant: "outline",
    className:
      "border-amber-600/30 bg-amber-600/10 text-amber-700 dark:text-amber-400",
  },
  failed: {
    label: "Failed",
    variant: "outline",
    className: "border-destructive/30 bg-destructive/10 text-destructive",
  },
};

export function briefingStatusDisplay(status: BriefingStatus): StatusDisplay {
  return (
    BRIEFING_STATUS_DISPLAY[status] ?? {
      label: status,
      variant: "outline" as const,
    }
  );
}

const SOURCE_STATUS_DISPLAY: Record<BriefingSourceStatus, StatusDisplay> = {
  ok: {
    label: "OK",
    variant: "outline",
    className:
      "border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400",
  },
  error: {
    label: "Error",
    variant: "outline",
    className: "border-destructive/30 bg-destructive/10 text-destructive",
  },
  skipped: {
    label: "Skipped",
    variant: "outline",
    className: "border-border bg-muted/40 text-muted-foreground",
  },
  timeout: {
    label: "Timed out",
    variant: "outline",
    className:
      "border-amber-600/30 bg-amber-600/10 text-amber-700 dark:text-amber-400",
  },
};

export function sourceStatusDisplay(
  status: BriefingSourceStatus,
): StatusDisplay {
  return (
    SOURCE_STATUS_DISPLAY[status] ?? {
      label: status,
      variant: "outline" as const,
    }
  );
}
