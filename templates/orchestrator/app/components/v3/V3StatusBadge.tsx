import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const STATUS_VARIANTS: Record<string, string> = {
  pending: "bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-600",
  running: "bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-700",
  done: "bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-700",
  failed: "bg-red-100 text-red-700 border-red-300 dark:bg-red-900/40 dark:text-red-300 dark:border-red-700",
  cancelled: "bg-orange-100 text-orange-700 border-orange-300 dark:bg-orange-900/40 dark:text-orange-300 dark:border-orange-700",
  paused: "bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700",
  skipped: "bg-gray-100 text-gray-600 border-gray-300 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-600",
  "awaiting-approval":
    "bg-purple-100 text-purple-700 border-purple-300 dark:bg-purple-900/40 dark:text-purple-300 dark:border-purple-700",
};

export interface V3StatusBadgeProps {
  status: string;
  className?: string;
}

export function V3StatusBadge({ status, className }: V3StatusBadgeProps) {
  const variant = STATUS_VARIANTS[status] ?? STATUS_VARIANTS.pending;
  const label =
    status === "awaiting-approval" ? "Awaiting Approval" : status;

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
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          status === "running" && "bg-blue-500 animate-pulse",
          status === "done" && "bg-emerald-500",
          status === "failed" && "bg-red-500",
          status === "cancelled" && "bg-orange-500",
          status === "skipped" && "bg-gray-400",
          status === "awaiting-approval" && "bg-purple-500",
          "bg-slate-400",
        )}
      />
      {label}
    </Badge>
  );
}
