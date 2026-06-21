import {
  IconAlertTriangle,
  IconCircleCheck,
  IconLoader2,
  IconPlayerSkipForward,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { RoutineRunView } from "@/hooks/use-routines";

type RunStatus = RoutineRunView["status"];

const STATUS_META: Record<
  RunStatus,
  { label: string; icon: typeof IconCircleCheck; className: string }
> = {
  success: {
    label: "Success",
    icon: IconCircleCheck,
    className:
      "border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
  error: {
    label: "Error",
    icon: IconAlertTriangle,
    className:
      "border-transparent bg-destructive/15 text-destructive dark:text-red-400",
  },
  running: {
    label: "Running",
    icon: IconLoader2,
    className:
      "border-transparent bg-blue-500/15 text-blue-600 dark:text-blue-400",
  },
  skipped: {
    label: "Skipped",
    icon: IconPlayerSkipForward,
    className: "border-transparent bg-muted text-muted-foreground",
  },
};

/** Terminal-or-running status badge for a single routine run row. */
export function RunStatusBadge({ status }: { status: RunStatus }) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <Badge className={cn("gap-1 font-normal", meta.className)}>
      <Icon
        className={cn("size-3.5", status === "running" && "animate-spin")}
      />
      {meta.label}
    </Badge>
  );
}
