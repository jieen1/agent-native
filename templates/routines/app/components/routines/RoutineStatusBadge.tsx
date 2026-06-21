import {
  IconCircleCheck,
  IconAlertTriangle,
  IconLoader2,
  IconPlayerSkipForward,
  IconClockPause,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { RoutineSummary } from "@/hooks/use-routines";

type RunStatus = NonNullable<RoutineSummary["lastStatus"]>;

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

interface RoutineStatusBadgeProps {
  status?: RoutineSummary["lastStatus"];
  enabled: boolean;
}

/**
 * Last-run status badge. When the routine has never run we show its enabled
 * state ("Scheduled" / "Paused") so a fresh routine isn't a blank cell.
 */
export function RoutineStatusBadge({
  status,
  enabled,
}: RoutineStatusBadgeProps) {
  if (!status) {
    return (
      <Badge
        variant="outline"
        className={cn(
          "gap-1 font-normal",
          enabled ? "text-muted-foreground" : "text-muted-foreground/70",
        )}
      >
        {enabled ? (
          <>
            <IconClockPause className="size-3.5 opacity-0" />
            Scheduled
          </>
        ) : (
          <>
            <IconClockPause className="size-3.5" />
            Paused
          </>
        )}
      </Badge>
    );
  }

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
