import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { useActionMutation } from "@agent-native/core/client";
import { toast } from "sonner";
import {
  IconArrowLeft,
  IconArrowRight,
  IconCalendar,
  IconExternalLink,
  IconFolder,
  IconGauge,
  IconHash,
  IconPlayerPause,
  IconPlayerPlay,
  IconShieldCheck,
  IconTag,
  IconUser,
  IconX,
} from "@tabler/icons-react";
import { APP_TITLE } from "@/lib/app-config";
import { useWorkItem } from "@/hooks/use-work-items";
import { useQueueControls } from "@/hooks/use-queue";
import { useRunGet, useRunGraph } from "@/hooks/use-runs";
import { useProjects } from "@/hooks/use-projects";
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

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return String(iso);
  }
}

function fmtDuration(startIso?: string | null, endIso?: string | null): string {
  if (!startIso || !endIso) return "—";
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

// Work-item console (FRONTEND §4). What the user sees on /items/:id:
//   • Header: title + business status + exec state + run/pause/cancel controls
//   • Metadata strip: type, priority, project, severity/env/blocked, timestamps
//   • Description (with placeholder when empty — never hide the section)
//   • Deliverable card: a CLICKABLE link to the PR/branch/artifact (not a chip)
//   • Run summary card: tokens, duration, node counts, link to /runs/:runId
//   • Status history table: fromStatus → toStatus, actor, runId, time
//   • Node list: each row LINKS to /runs/:runId so the rich node inspector
//     (input/output/runtime/tokens/diff) on that page is reachable
// All data flows from get-work-item + run-get + run-graph + list-projects.
export default function WorkItemRoute() {
  const { t } = useTranslation();
  const { id } = useParams();
  const { data: item, isLoading } = useWorkItem(id);
  const { runStart, runPause, runCancel } = useQueueControls();
  const runId = item?.workflowRunId ?? undefined;
  const { data: graph } = useRunGraph(runId);
  const { data: runSummary } = useRunGet(runId);
  const { data: projects = [] } = useProjects();
  const navAction = useActionMutation("navigate", {});

  const [cancelRunOpen, setCancelRunOpen] = useState(false);
  const [approval, setApproval] = useState<ApprovalTarget | null>(null);

  useEffect(() => {
    if (id) navAction.mutate({ view: "item", id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const projectKey = useMemo(() => {
    if (!item) return null;
    return projects.find((p) => p.id === item.projectId)?.key ?? item.projectId;
  }, [projects, item]);

  if (!id) return null;

  function onError(e: unknown) {
    toast.error(e instanceof Error ? e.message : t("common.actionFailed"));
  }

  const isRunning = item?.execState === "running";
  const isPaused = item?.execState === "paused";
  const awaitingNode = graph?.nodeRuns.find(
    (n) => n.status === "awaiting-approval",
  );

  // Compose the deliverable display: every {kind, ref} maps to either an
  // external URL (pr / branch via gitRemote on the run) or a plain ref string.
  // `Deliverable.ref` is typed `unknown` (it's JSON the run wrote) — coerce.
  const deliverable = item?.deliverable ?? null;
  const deliverableRefStr: string = deliverable
    ? typeof deliverable.ref === "string"
      ? deliverable.ref
      : JSON.stringify(deliverable.ref)
    : "";
  const deliverableHref: string | null = /^https?:\/\//i.test(
    deliverableRefStr,
  )
    ? deliverableRefStr
    : null;

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col px-4 py-6 sm:px-6 sm:py-8">
      {/* ── HEADER ──────────────────────────────────────────────────────── */}
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
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

      {/* ── METADATA STRIP ──────────────────────────────────────────────── */}
      {item ? (
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-card/60 px-3 py-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <IconTag className="size-3.5" />
            <span className="font-medium text-foreground">{item.type}</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <IconGauge className="size-3.5" />
            P{item.priority}
          </span>
          {projectKey ? (
            <Link
              to={`/projects/${item.projectId}`}
              className="inline-flex items-center gap-1.5 hover:text-foreground hover:underline"
            >
              <IconFolder className="size-3.5" />
              <span className="font-mono">{projectKey}</span>
            </Link>
          ) : null}
          {item.severity ? <SeverityChip severity={item.severity} /> : null}
          {item.environment ? <EnvTag env={item.environment} /> : null}
          {item.blocked ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-600 ring-1 ring-inset ring-red-500/30 dark:text-red-400">
              {t("board.blocked")}
              {item.blockedReason ? `: ${item.blockedReason}` : ""}
            </span>
          ) : null}
          <span className="ml-auto inline-flex items-center gap-1.5">
            <IconCalendar className="size-3.5" />
            {t("task.created")}: {fmtDateTime(item.createdAt)}
          </span>
          <span className="inline-flex items-center gap-1.5">
            {t("task.updated")}: {fmtDateTime(item.updatedAt)}
          </span>
        </div>
      ) : null}

      {/* ── AWAITING APPROVAL BANNER ────────────────────────────────────── */}
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

      {/* ── DESCRIPTION (always renders; placeholder when empty) ─────────── */}
      <section className="mb-5">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("task.descriptionTitle")}
        </h2>
        <p
          className={cn(
            "whitespace-pre-wrap rounded-lg border border-border bg-card p-4 text-sm",
            item?.description
              ? "text-foreground"
              : "italic text-muted-foreground",
          )}
        >
          {item?.description || t("task.noDescription")}
        </p>
      </section>

      {/* ── MAIN GRID: nodes + side (deliverable / run summary / history) ── */}
      <div className="grid min-h-0 flex-1 gap-5 lg:grid-cols-[1fr_minmax(280px,340px)]">
        {/* ── NODES (rows link to the rich run console) ─────────────────── */}
        <section className="min-w-0">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("runs.nodes")}
            </h2>
            {runId ? (
              <Button asChild size="sm" variant="ghost">
                <Link to={`/runs/${runId}`}>
                  {t("task.openRunConsole")}
                  <IconArrowRight className="size-3.5" />
                </Link>
              </Button>
            ) : null}
          </div>
          {!runId ? (
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
                <li key={nr.id}>
                  <Link
                    to={`/runs/${runId}`}
                    className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 transition-colors hover:bg-accent"
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
                    <IconArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── SIDE: deliverable + run summary + status history ──────────── */}
        <aside className="min-w-0 space-y-5">
          {/* deliverable card — CLICKABLE link to PR / branch / artifact */}
          {deliverable ? (
            <div>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("board.deliverable")}
              </h2>
              {deliverableHref ? (
                <a
                  href={deliverableHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm transition-colors hover:bg-emerald-500/20"
                >
                  <IconExternalLink className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                      {deliverable.kind}
                    </span>
                    <span className="block truncate text-xs text-emerald-700/80 group-hover:underline dark:text-emerald-300/80">
                      {deliverableRefStr}
                    </span>
                  </span>
                </a>
              ) : (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
                  <span className="block text-xs font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                    {deliverable.kind}
                  </span>
                  <span className="mt-0.5 block break-all font-mono text-xs text-emerald-700/80 dark:text-emerald-300/80">
                    {deliverableRefStr}
                  </span>
                </div>
              )}
            </div>
          ) : null}

          {/* run summary card */}
          {runId ? (
            <div>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("task.runSummary")}
              </h2>
              <div className="rounded-lg border border-border bg-card p-3 text-sm">
                <dl className="grid gap-2">
                  <div className="flex items-center justify-between">
                    <dt className="text-xs text-muted-foreground">
                      {t("task.tokensSpent")}
                    </dt>
                    <dd className="font-mono text-xs">
                      {runSummary?.tokensSpent?.toLocaleString() ?? "—"}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-xs text-muted-foreground">
                      {t("task.duration")}
                    </dt>
                    <dd className="font-mono text-xs">
                      {fmtDuration(
                        runSummary?.startedAt,
                        runSummary?.completedAt,
                      )}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-xs text-muted-foreground">
                      {t("task.nodesDone")}
                    </dt>
                    <dd className="font-mono text-xs">
                      {runSummary?.counts?.done ?? 0}/
                      {runSummary?.nodeRunCount ?? 0}
                    </dd>
                  </div>
                </dl>
                <Button asChild size="sm" variant="outline" className="mt-3 w-full">
                  <Link to={`/runs/${runId}`}>
                    {t("task.openRunConsole")}
                    <IconArrowRight className="size-3.5" />
                  </Link>
                </Button>
              </div>
            </div>
          ) : null}

          {/* status history — full row with fromStatus → toStatus + actor */}
          <div>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("task.statusTrail")}
            </h2>
            {item?.statusLog && item.statusLog.length > 0 ? (
              <ol className="grid gap-1.5">
                {item.statusLog
                  .slice()
                  .reverse()
                  .map((row) => (
                    <li
                      key={row.id}
                      className="rounded-md border border-border bg-card px-2.5 py-2 text-xs"
                    >
                      <div className="flex items-baseline gap-1.5">
                        {row.fromStatus ? (
                          <>
                            <span className="text-muted-foreground">
                              {String(
                                t(`status.${row.fromStatus}`, {
                                  defaultValue: row.fromStatus,
                                }),
                              )}
                            </span>
                            <IconArrowRight className="size-3 shrink-0 text-muted-foreground" />
                          </>
                        ) : null}
                        <span className="font-medium">
                          {String(
                            t(`status.${row.toStatus}`, {
                              defaultValue: row.toStatus,
                            }),
                          )}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                        {row.actor ? (
                          <span className="inline-flex items-center gap-1">
                            <IconUser className="size-3" />
                            {row.actor}
                          </span>
                        ) : null}
                        {row.runId ? (
                          <Link
                            to={`/runs/${row.runId}`}
                            className="inline-flex items-center gap-1 font-mono hover:text-foreground hover:underline"
                          >
                            <IconHash className="size-3" />
                            {row.runId.slice(0, 12)}
                          </Link>
                        ) : null}
                        <span className="ml-auto">{fmtDateTime(row.at)}</span>
                      </div>
                    </li>
                  ))}
              </ol>
            ) : (
              <p className="rounded-md border border-dashed border-border p-3 text-center text-xs italic text-muted-foreground">
                {t("task.noStatusHistory")}
              </p>
            )}
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
