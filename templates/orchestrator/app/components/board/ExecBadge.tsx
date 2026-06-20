import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { execColor, type ExecState } from "@/lib/status-colors";

// Automation-overlay badge (FRONTEND §2): the work item's execState — the AI
// fleet state, SEPARATE from business status. Shown on a card only when a run is
// active/relevant; `running` pulses. Reads the single status-colors source so
// "running" blue matches every other surface.
export interface ExecBadgeProps {
  state: string;
  className?: string;
  /** Hide the idle state (cards usually omit it). Defaults to false. */
  hideIdle?: boolean;
}

export function ExecBadge({ state, className, hideIdle }: ExecBadgeProps) {
  const { t } = useTranslation();
  if (hideIdle && state === "idle") return null;
  const color = execColor(state);
  const label = t(`exec.${state}`, { defaultValue: state });
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        color.badge,
        className,
      )}
    >
      {state === "running" ? (
        <span className="size-1.5 animate-pulse rounded-full bg-current" />
      ) : null}
      {label}
    </span>
  );
}
