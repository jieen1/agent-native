import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleX,
  IconClockHour4,
  IconLoader2,
  IconRocket,
} from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  useDeployHistory,
  useDeployStatus,
  useTriggerDeploy,
  type DeployRunSummary,
  type DeployStage,
  type DeployStageEntry,
  type DeployStatus,
} from "@/hooks/use-deploy";
import { cn } from "@/lib/utils";

const APPS = ["orchestrator", "tracker"] as const;

const STAGE_LABEL: Record<DeployStage, string> = {
  queued: "Queued",
  "backing-up": "Backing up",
  building: "Building",
  syncing: "Verifying build",
  restarting: "Restarting",
  verifying: "Health check",
  "rolling-back": "Rolling back",
  done: "Done",
};

const STATUS_TONE: Record<DeployStatus, string> = {
  queued: "bg-muted text-muted-foreground border-border",
  running: "bg-info/15 text-info border-info/30",
  succeeded: "bg-success/15 text-success border-success/30",
  failed: "bg-destructive/15 text-destructive border-destructive/30",
  rolled_back: "bg-warning/15 text-warning border-warning/30",
};

const STATUS_LABEL: Record<DeployStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  rolled_back: "Rolled back",
};

function StageRow({ entry }: { entry: DeployStageEntry }) {
  const running = !entry.completedAt;
  const ok = entry.ok !== false;
  return (
    <div className="flex items-start gap-2 py-1.5">
      {running ? (
        <IconLoader2 className="mt-0.5 size-4 shrink-0 animate-spin text-info" />
      ) : ok ? (
        <IconCircleCheck className="mt-0.5 size-4 shrink-0 text-success" />
      ) : (
        <IconCircleX className="mt-0.5 size-4 shrink-0 text-destructive" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {STAGE_LABEL[entry.stage] ?? entry.stage}
        </p>
        {entry.detail ? (
          <p
            className={cn(
              "mt-0.5 truncate text-xs",
              ok ? "text-muted-foreground" : "text-destructive",
            )}
            title={entry.detail}
          >
            {entry.detail}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function DeployProgress({ deployRunId }: { deployRunId: string }) {
  const { data } = useDeployStatus(deployRunId);
  if (!data) return null;

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-2 flex items-center gap-2">
        <Badge
          variant="outline"
          className={cn("gap-1 text-xs font-normal", STATUS_TONE[data.status])}
        >
          {data.status === "running" || data.status === "queued" ? (
            <IconLoader2 className="size-3 animate-spin" />
          ) : null}
          {STATUS_LABEL[data.status]}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {data.apps.join(", ")} · {data.target}
        </span>
        {data.commitSha ? (
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
            {data.commitSha.slice(0, 7)}
          </span>
        ) : null}
      </div>
      <div className="divide-y divide-border">
        {data.stageLog.map((entry, i) => (
          <StageRow key={`${entry.stage}-${i}`} entry={entry} />
        ))}
      </div>
      {data.error ? (
        <Alert variant="destructive" className="mt-3 py-2">
          <AlertDescription className="text-xs">{data.error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function DeployHistoryRow({ run }: { run: DeployRunSummary }) {
  return (
    <li className="rounded-lg border bg-card px-4 py-3">
      <div className="flex items-center gap-2">
        <Badge
          variant="outline"
          className={cn("gap-1 text-xs font-normal", STATUS_TONE[run.status])}
        >
          {STATUS_LABEL[run.status]}
        </Badge>
        <span className="truncate text-xs text-muted-foreground">
          {run.apps.join(", ")}
        </span>
        {run.commitSha ? (
          <span className="font-mono text-[10px] text-muted-foreground">
            {run.commitSha.slice(0, 7)}
          </span>
        ) : null}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {run.createdAt ? new Date(run.createdAt).toLocaleString() : ""}
        </span>
      </div>
      {run.error ? (
        <p className="mt-1 truncate text-xs text-destructive" title={run.error}>
          {run.error}
        </p>
      ) : null}
    </li>
  );
}

export function DeployTab() {
  const { t } = useTranslation();
  const [selectedApps, setSelectedApps] = useState<string[]>([...APPS]);
  const [activeDeployId, setActiveDeployId] = useState<string | null>(null);
  const [triggerError, setTriggerError] = useState<string | null>(null);

  const trigger = useTriggerDeploy();
  const { data: history } = useDeployHistory();

  const liveRun = history?.find(
    (r) => r.status === "queued" || r.status === "running",
  );
  const displayedRunId = activeDeployId ?? liveRun?.id ?? null;

  function toggleApp(app: string, checked: boolean) {
    setSelectedApps((prev) =>
      checked ? [...new Set([...prev, app])] : prev.filter((a) => a !== app),
    );
  }

  function handleDeploy() {
    setTriggerError(null);
    trigger.mutate(
      { apps: selectedApps, target: "101" },
      {
        onSuccess: (result: unknown) => {
          const r = result as { deployRunId: string };
          setActiveDeployId(r.deployRunId);
          toast.success(t("settings.deployStarted"));
        },
        onError: (err: unknown) => {
          const message =
            err instanceof Error ? err.message : t("common.actionFailed");
          setTriggerError(message);
          toast.error(message);
        },
      },
    );
  }

  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <IconRocket className="size-5 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("settings.deployTitle")}</h2>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        {t("settings.deploySubtitle")}
      </p>

      <div className="space-y-3 rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-center gap-4">
          <span className="text-xs text-muted-foreground">
            {t("settings.deployTarget")}: <code>101</code>
          </span>
          <div className="flex items-center gap-3">
            {APPS.map((app) => (
              <label key={app} className="flex items-center gap-1.5 text-sm">
                <Checkbox
                  checked={selectedApps.includes(app)}
                  onCheckedChange={(c) => toggleApp(app, c === true)}
                  disabled={!!liveRun}
                />
                {app}
              </label>
            ))}
          </div>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                size="sm"
                className="ml-auto gap-1.5"
                disabled={selectedApps.length === 0 || !!liveRun}
                title={liveRun ? t("settings.deployAlreadyRunning") : undefined}
              >
                <IconRocket className="size-4" />
                {t("settings.deployTrigger")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("settings.deployConfirmTitle")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("settings.deployConfirmDesc", {
                    apps: selectedApps.join(", "),
                  })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                <AlertDialogAction onClick={handleDeploy}>
                  {t("settings.deployConfirmAction")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>

        {triggerError ? (
          <Alert variant="destructive" className="py-2">
            <IconAlertTriangle className="size-4" />
            <AlertDescription className="text-xs">
              {triggerError}
            </AlertDescription>
          </Alert>
        ) : null}
      </div>

      {displayedRunId ? (
        <div className="mt-4">
          <DeployProgress deployRunId={displayedRunId} />
        </div>
      ) : null}

      <div className="mt-6">
        <div className="mb-2 flex items-center gap-2">
          <IconClockHour4 className="size-4 text-muted-foreground" />
          <h3 className="text-xs font-semibold text-muted-foreground">
            {t("settings.deployHistoryTitle")}
          </h3>
        </div>
        {history && history.length > 0 ? (
          <ul className="grid gap-2">
            {history.map((run) => (
              <DeployHistoryRow key={run.id} run={run} />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t("settings.deployHistoryEmpty")}
          </p>
        )}
      </div>
    </section>
  );
}
