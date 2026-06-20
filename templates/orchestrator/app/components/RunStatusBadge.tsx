import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

// Badge for v2 run + NodeRun statuses (superset of the v1 StatusBadge): adds
// `ready`, `paused`, and `awaiting-approval` which the v2 engine produces.
type RunOrNodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "paused"
  | "done"
  | "failed"
  | "cancelled"
  | "skipped"
  | "awaiting-approval";

const STYLES: Record<RunOrNodeStatus, string> = {
  pending: "bg-muted text-muted-foreground",
  ready:
    "bg-amber-500/15 text-amber-600 dark:text-amber-400 ring-1 ring-inset ring-amber-500/30",
  running:
    "bg-blue-500/15 text-blue-600 dark:text-blue-400 ring-1 ring-inset ring-blue-500/30",
  paused:
    "bg-violet-500/15 text-violet-600 dark:text-violet-400 ring-1 ring-inset ring-violet-500/30",
  done: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 ring-1 ring-inset ring-emerald-500/30",
  failed:
    "bg-red-500/15 text-red-600 dark:text-red-400 ring-1 ring-inset ring-red-500/30",
  cancelled: "bg-muted text-muted-foreground line-through",
  skipped: "bg-muted/60 text-muted-foreground/70 [border-style:dashed]",
  "awaiting-approval":
    "bg-orange-500/15 text-orange-600 dark:text-orange-400 ring-1 ring-inset ring-orange-500/30",
};

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
        STYLES[status],
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
