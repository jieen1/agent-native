import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import { StatusMarker } from "./StatusMarker";

// Semantic tokens (--info/--success/--...) are theme-aware (global.css
// :root/.dark), so a single class per status covers both themes — no `dark:`
// variant needed the way the old literal palette required one.
const STATUS_VARIANTS: Record<string, string> = {
  pending: "bg-muted text-muted-foreground border-border",
  running: "bg-info/15 text-info border-info/30",
  done: "bg-success/15 text-success border-success/30",
  failed: "bg-destructive/15 text-destructive border-destructive/30",
  cancelled: "bg-warning/15 text-warning border-warning/30",
  paused: "bg-warning/15 text-warning border-warning/30",
  skipped: "bg-muted text-muted-foreground border-border",
  "awaiting-approval": "bg-agent/15 text-agent border-agent/30",
};

export interface V3StatusBadgeProps {
  status: string;
  className?: string;
}

export function V3StatusBadge({ status, className }: V3StatusBadgeProps) {
  const variant = STATUS_VARIANTS[status] ?? STATUS_VARIANTS.pending;
  const label = status === "awaiting-approval" ? "Awaiting Approval" : status;

  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 font-normal",
        variant,
        status === "running" && "animate-pulse",
        className,
      )}
    >
      <StatusMarker status={status} size="sm" ringSize={11} />
      {label}
    </Badge>
  );
}
