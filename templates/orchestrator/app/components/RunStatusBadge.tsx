import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { runStatusBadge, type RunOrNodeStatus } from "@/lib/status-colors";

// Badge for v2 run + NodeRun statuses (superset of the v1 StatusBadge): adds
// `ready`, `paused`, and `awaiting-approval` which the v2 engine produces.
// Tints come from the SINGLE status-colors map (C2) — never inline per surface.

/** Translation key per status; falls back to the raw status if missing. */
const LABEL_KEY: Record<RunOrNodeStatus, string> = {
  pending: "status.pending",
  ready: "status.ready",
  running: "status.running",
  paused: "status.paused",
  done: "status.done",
  failed: "status.failed",
  cancelled: "status.cancelled",
  skipped: "status.skipped",
  "awaiting-approval": "status.awaitingApproval",
};

export function RunStatusBadge({
  status,
  className,
}: {
  status: RunOrNodeStatus;
  className?: string;
}) {
  const { t } = useTranslation();
  const label = t(LABEL_KEY[status], { defaultValue: status });
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        runStatusBadge(status),
        className,
      )}
    >
      {status === "running" ? (
        <span className="size-1.5 animate-pulse rounded-full bg-current" />
      ) : null}
      {label}
    </span>
  );
}
