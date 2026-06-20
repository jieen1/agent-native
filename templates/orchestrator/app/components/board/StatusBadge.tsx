import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { categoryColor } from "@/lib/status-colors";

// Business-status badge for a work item (FRONTEND §C3 / §2). Renders the stage
// label via i18n (`status.<key>` — falls back to the raw stage key for the
// Chinese default-scheme stages that have no separate translation) and tints by
// the stage's CATEGORY using the single status-colors source. Distinct from the
// v1 run-status `StatusBadge` (which colors automation/run states, not business
// pipeline stages).
export interface StatusBadgeProps {
  /** The stage key, e.g. "开发中" / "in_dev". */
  status: string;
  /** The stage's category (drives the color). */
  category: string;
  className?: string;
}

export function StatusBadge({ status, category, className }: StatusBadgeProps) {
  const { t } = useTranslation();
  const color = categoryColor(category);
  // Status stage keys are i18n keys too (FRONTEND §C1): try `status.<key>`,
  // fall back to the stage key itself (the default zh schemes ARE the label).
  const label = t(`status.${status}`, { defaultValue: status });
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 truncate rounded-full px-2 py-0.5 text-xs font-medium",
        color.badge,
        className,
      )}
      title={label}
    >
      {label}
    </span>
  );
}
