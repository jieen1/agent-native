/** Format an ISO timestamp as a short relative age ("3m", "2h", "5d ago"). */
export function formatRelativeTime(iso?: string): string {
  if (!iso) return "Never";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "Never";

  const diffMs = Date.now() - then;
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);

  const minutes = Math.floor(abs / 60_000);
  let label: string;
  if (minutes < 1) label = "just now";
  else if (minutes < 60) label = `${minutes}m`;
  else {
    const hours = Math.floor(minutes / 60);
    if (hours < 24) label = `${hours}h`;
    else {
      const days = Math.floor(hours / 24);
      if (days < 7) label = `${days}d`;
      else {
        return new Date(then).toLocaleDateString([], {
          month: "short",
          day: "numeric",
        });
      }
    }
  }

  if (label === "just now") return label;
  return future ? `in ${label}` : `${label} ago`;
}

/** Format a wall-clock duration in ms as a compact label ("1.2s", "3m 4s"). */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1_000) return `${ms}ms`;
  const totalSeconds = ms / 1_000;
  if (totalSeconds < 60) {
    // One decimal under 10s, whole seconds otherwise, for a stable width.
    return totalSeconds < 10
      ? `${totalSeconds.toFixed(1)}s`
      : `${Math.round(totalSeconds)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** Absolute, locale-formatted timestamp for tooltips/titles. */
export function formatAbsoluteTime(iso?: string): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return undefined;
  return date.toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
