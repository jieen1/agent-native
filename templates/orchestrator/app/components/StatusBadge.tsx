import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

type AnyStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "skipped";

const STYLES: Record<AnyStatus, string> = {
  pending: "bg-muted text-muted-foreground",
  running:
    "bg-blue-500/15 text-blue-600 dark:text-blue-400 ring-1 ring-inset ring-blue-500/30",
  done: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 ring-1 ring-inset ring-emerald-500/30",
  failed:
    "bg-red-500/15 text-red-600 dark:text-red-400 ring-1 ring-inset ring-red-500/30",
  cancelled: "bg-muted text-muted-foreground line-through",
  skipped: "bg-muted/60 text-muted-foreground/70",
};

export function StatusBadge({
  status,
  className,
}: {
  status: AnyStatus;
  className?: string;
}) {
  const { t } = useTranslation();
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
      {t(`status.${status}`)}
    </span>
  );
}
