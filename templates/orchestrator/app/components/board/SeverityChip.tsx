import { IconAlertTriangle } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { severityColor } from "@/lib/status-colors";

// Incident severity chip (FRONTEND §2 — SEV1..4 on incidents). The label is the
// stable SEV token itself (not translated — it is a code, like "SEV1"); only the
// surrounding "severity" word in tooltips is i18n. Reads the single color source.
export interface SeverityChipProps {
  severity: string;
  className?: string;
}

export function SeverityChip({ severity, className }: SeverityChipProps) {
  const color = severityColor(severity);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold",
        color.badge,
        className,
      )}
    >
      <IconAlertTriangle className="size-3" aria-hidden="true" />
      {severity}
    </span>
  );
}
