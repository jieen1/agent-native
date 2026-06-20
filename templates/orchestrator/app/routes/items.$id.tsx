import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { useActionMutation } from "@agent-native/core/client";
import { toast } from "sonner";
import {
  IconArrowLeft,
  IconExternalLink,
  IconPlayerPause,
  IconPlayerPlay,
  IconShieldCheck,
  IconX,
} from "@tabler/icons-react";
import { APP_TITLE } from "@/lib/app-config";
import { useWorkItem } from "@/hooks/use-work-items";
import { useQueueControls } from "@/hooks/use-queue";
import { useRunGraph } from "@/hooks/use-runs";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/board/StatusBadge";
import { ExecBadge } from "@/components/board/ExecBadge";
import { SeverityChip } from "@/components/board/SeverityChip";
import { EnvTag } from "@/components/board/EnvTag";
import { ConfirmDialog } from "@/components/board/ConfirmDialog";
import {
  ApprovalDialog,
  type ApprovalTarget,
} from "@/components/dialogs/ApprovalDialog";
import { RunStatusBadge } from "@/components/RunStatusBadge";
import { nodeStatusDot } from "@/lib/status-colors";
import { cn } from "@/lib/utils";

export function meta() {
  return [{ title: `${APP_TITLE} — Work item` }];
}

// Work-item / run console (FRONTEND §4, P3d scope). Header (status + exec
// controls), the live run graph (read-only node list reusing the run hooks), the
// status trail, the deliverable, and the human-approval surfacing. The full
// React-Flow canvas + in-VM terminal + diff viewer are P4.
export default function WorkItemRoute() {
  const { t } = useTranslation();
  const { id } = useParams();
  const { data: item, isLoading } = useWorkItem(id);
  const { runStart, runPause, runCancel } = useQueueControls();
  const { data: graph } = useRunGraph(item?.workflowRunId ?? undefined);
  const navAction = useActionMutation("navigate", {});

  const [cancelRunOpen, setCancelRunOpen] = useState(false);
  const [approval, setApproval] = useState<ApprovalTarget | null>(null);

  useEffect(() => {
    if (id) navAction.mutate({ view: "item", id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!id) return null;

  function onError(e: unknown) {
    toast.error(e instanceof Error ? e.message : t("common.actionFailed"));
  }

  const isRunning = item?.execState === "running";
  const isPaused = item?.execState === "paused";
  const awaitingNode = graph?.nodeRuns.find(
    (n) => n.status === "awaiting-approval",
  );

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <Link to="/board">
              <IconArrowLeft className="size-4" />
              {t("board.title")}
            </Link>
          </Button>
          {isLoading || !item ? (
            <Skeleton className="h-6 w-48" />
          ) : (
            <>
              <h1 className="truncate text-base font-semibold sm:text-lg">
                {item.title}
              </h1>
              <StatusBadge
                status={item.status}
                category={item.statusCategory}
              />
              {item.execState !== "idle" ? (
                <ExecBadge state={item.execState} hideIdle />
              ) : null}
            </>
          )}
        </div>
        {item ? (
          <div className="flex items-center gap-2">
            {!isRunning && !isPaused ? (
              <Button
                size="sm"
                disabled={runStart.isPending}
                onClick={() =>
                  runStart.mutate(
                    { workItemId: item.id, wait: false },
                    {
                      onSuccess: () => toast.success(t("board.runStarted")),
                      onError,
                    },
                  )
                }
              >
                <IconPlayerPlay className="size-4" />
                {t("common.run")}
              </Button>
            ) : null}
            {isRunning && item.workflowRunId ? (
              <Button
                size="sm"
                variant="outline"
                disabled={runPause.isPending}
                onClick={() =>
                  runPause.mutate(
                    { runId: item.workflowRunId! },
                    {
                      onSuccess: () => toast.success(t("board.runPaused")),
                      onError,
                    },
                  )
                }
              >
                <IconPlayerPause className="size-4" />
                {t("runs.pause")}
              </Button>
            ) : null}
            {(isRunning || isPaused) && item.workflowRunId ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setCancelRunOpen(true)}
              >
                <IconX className="size-4" />
                {t("runs.cancel")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </header>

      {/* meta strip */}
      {item ? (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          {item.severity ? <SeverityChip severity={item.severity} /> : null}
          {item.environment ? <EnvTag env={item.environment} /> : null}
          {item.blocked ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-600 ring-1 ring-inset ring-red-500/30 dark:text-red-400">
              {t("board.blocked")}
              {item.blockedReason ? `: ${item.blockedReason}` : ""}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* awaiting-approval banner */}
      {awaitingNode && item?.workflowRunId ? (
        <button
          type="button"
          onClick={() =>
            setApproval({
              runId: item.workflowRunId!,
              nodeRunId: awaitingNode.id,
              nodeTitle: awaitingNode.title || awaitingNode.nodeId,
            })
          }
          className="mb-4 flex w-full items-center gap-3 rounded-lg border border-orange-500/30 bg-orange-500/10 px-4 py-2.5 text-left text-sm hover:bg-orange-500/20"
        >
          <IconShieldCheck className="size-4 shrink-0 text-orange-600 dark:text-orange-400" />
          <span className="font-medium text-orange-700 dark:text-orange-300">
            {t("approval.prompt")}
          </span>
          <span className="ml-auto font-medium">
            {awaitingNode.title || awaitingNode.nodeId}
          </span>
        </button>
      ) : null}

      {/* description */}
      {item?.description ? (
        <p className="mb-5 whitespace-pre-wrap rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
          {item.description}
        </p>
      ) : null}

      <div className="grid min-h-0 flex-1 gap-5 lg:grid-cols-[1fr_minmax(260px,320px)]">
        {/* run graph (read-only node list) */}
        <section className="min-w-0">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("runs.nodes")}
          </h2>
          {!item?.workflowRunId ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              {t("runs.notStarted")}
            </div>
          ) : !graph ? (
            <Skeleton className="h-40 w-full rounded-lg" />
          ) : graph.nodeRuns.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              {t("runs.notStarted")}
            </div>
          ) : (
            <ul className="grid gap-1.5">
              {graph.nodeRuns.map((nr) => (
                <li
                  key={nr.id}
                  className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2"
                >
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      nodeStatusDot(nr.status),
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {nr.title || nr.nodeId}
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {nr.nodeId} · {nr.type}
                    </span>
                  </span>
                  <RunStatusBadge status={nr.status} />
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* side: deliverable + status trail */}
        <aside className="min-w-0 space-y-5">
          {item?.deliverable ? (
            <div>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("board.deliverable")}
              </h2>
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
                <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-300">
                  <IconExternalLink className="size-3.5" />
                  {item.deliverable.kind}
                </span>
              </div>
            </div>
          ) : null}

          <div>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("task.progress")}
            </h2>
            {item?.statusLog && item.statusLog.length > 0 ? (
              <ol className="grid gap-1.5">
                {item.statusLog
                  .slice()
                  .reverse()
                  .map((row) => (
                    <li
                      key={row.id}
                      className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs"
                    >
                      <span className="truncate font-medium">
                        {t(`status.${row.toStatus}`, {
                          defaultValue: row.toStatus,
                        })}
                      </span>
                      <span className="ml-auto shrink-0 text-muted-foreground">
                        {new Date(row.at).toLocaleDateString()}
                      </span>
                    </li>
                  ))}
              </ol>
            ) : null}
          </div>
        </aside>
      </div>

      <ConfirmDialog
        open={cancelRunOpen}
        onOpenChange={setCancelRunOpen}
        title={t("dialog.cancelRunTitle")}
        description={t("dialog.cancelRunBody")}
        confirmLabel={t("runs.cancel")}
        pending={runCancel.isPending}
        onConfirm={() => {
          if (!item?.workflowRunId) {
            setCancelRunOpen(false);
            return;
          }
          runCancel.mutate(
            { runId: item.workflowRunId },
            {
              onSuccess: () => {
                setCancelRunOpen(false);
                toast.success(t("board.runCancelled"));
              },
              onError: (e: unknown) => {
                setCancelRunOpen(false);
                onError(e);
              },
            },
          );
        }}
      />
      <ApprovalDialog
        open={!!approval}
        onOpenChange={(o) => !o && setApproval(null)}
        target={approval}
      />
    </div>
  );
}
