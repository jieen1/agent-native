import { useTranslation } from "react-i18next";
import { IconActivity, IconServer2 } from "@tabler/icons-react";
import { useQueueStatus } from "@/hooks/use-queue";
import { cn } from "@/lib/utils";

// Global capacity chip (FRONTEND §0): surfaces BOTH concurrency ceilings so they
// are never a surprise — running/concurrencyDegree work items and
// vmsInUse/maxConcurrentVMs microVMs — plus a scheduler-liveness dot, all from
// queue-status (which self-observes schedulerAlive). Hidden when the sidebar is
// collapsed (it is text-heavy).
export function CapacityChip() {
  const { t } = useTranslation();
  const { data } = useQueueStatus();
  if (!data) return null;

  return (
    <div className="border-t border-sidebar-border px-2 py-1.5">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{t("topbar.capacity")}</span>
        <span
          className={cn(
            "size-1.5 rounded-full",
            data.schedulerAlive ? "bg-emerald-500" : "bg-amber-500",
          )}
          title={
            data.schedulerAlive
              ? t("topbar.schedulerAlive")
              : t("topbar.schedulerDown")
          }
          aria-label={
            data.schedulerAlive
              ? t("topbar.schedulerAlive")
              : t("topbar.schedulerDown")
          }
        />
      </div>
      <div className="mt-1 flex items-center gap-3 text-xs text-sidebar-foreground">
        <span className="inline-flex items-center gap-1" title={t("topbar.capacity")}>
          <IconActivity className="size-3.5 shrink-0" />
          {t("topbar.capacityTasks", {
            running: data.running,
            degree: data.concurrencyDegree,
          })}
        </span>
        <span className="inline-flex items-center gap-1">
          <IconServer2 className="size-3.5 shrink-0" />
          {t("topbar.capacityVMs", {
            used: data.vmsInUse,
            max: data.maxConcurrentVMs,
          })}
        </span>
      </div>
    </div>
  );
}
