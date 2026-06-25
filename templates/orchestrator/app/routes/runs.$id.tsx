import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { useTranslation } from "react-i18next";
import {
  IconArrowLeft,
  IconCoin,
  IconPackage,
  IconPlayerPause,
  IconPlayerPlay,
  IconRefresh,
  IconX,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { useActionMutation } from "@agent-native/core/client";
import { APP_TITLE } from "@/lib/app-config";
import {
  useNodeRun,
  useRunControls,
  useRunEvents,
  useRunGet,
  useRunGraph,
} from "@/hooks/use-runs";
import { RunStatusBadge } from "@/components/RunStatusBadge";
import { WorkflowCanvas } from "@/components/workflow-canvas/WorkflowCanvas";
import { runGraphToCanvas } from "@/components/run-console/run-model";
import { NodeInspector } from "@/components/run-console/NodeInspector";
import { RunTabs } from "@/components/run-console/RunTabs";
import { OverrideDialog } from "@/components/run-console/OverrideDialog";
import { DiffSheet } from "@/components/run-console/DiffSheet";
import { ConfirmDialog } from "@/components/board/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function meta() {
  return [{ title: `${APP_TITLE} — 运行详情` }];
}

// Work-item / Run console (FRONTEND §4 / §6 run overlay). The live DAG is the
// SHARED <WorkflowCanvas mode="run"> fed by run-graph; the right panel is the
// node inspector (node-get); the bottom is the 5 tabs (Overview / Steps /
// Terminal / Deliverable / Events). Read-only canvas — no editing in run mode.
export default function RunConsoleRoute() {
  const { t } = useTranslation();
  const { id: runId } = useParams();

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  const { data: graph, isLoading: graphLoading, error } = useRunGraph(runId);
  const { data: summary } = useRunGet(runId);
  const { data: eventsData } = useRunEvents(runId);
  const {
    runStart,
    runPause,
    runResume,
    runCancel,
    runRetryNode,
    nodeOverride,
  } = useRunControls();
  const navigate = useActionMutation("navigate", {});

  // Resolve the selected TEMPLATE node id → the most-relevant NodeRun id (the
  // canvas selects by template node; node-get / the inspector need a NodeRun id).
  // Prefer a running/failed run, else the latest by iteration/fanout.
  const selectedNodeRunId = useMemo<string | null>(() => {
    if (!selectedNodeId || !graph) return null;
    const candidates = graph.nodeRuns.filter(
      (nr) => nr.nodeId === selectedNodeId,
    );
    if (candidates.length === 0) return null;
    const rank: Record<string, number> = {
      running: 5,
      failed: 4,
      "awaiting-approval": 3,
      done: 2,
      ready: 1,
      pending: 0,
      skipped: 0,
    };
    return [...candidates].sort((a, b) => {
      const r = (rank[b.status] ?? 0) - (rank[a.status] ?? 0);
      if (r !== 0) return r;
      if (a.iteration !== b.iteration) return b.iteration - a.iteration;
      return b.fanoutIndex - a.fanoutIndex;
    })[0].id;
  }, [selectedNodeId, graph]);

  const { data: node, isLoading: nodeLoading } = useNodeRun(
    runId,
    selectedNodeRunId ?? undefined,
  );

  // Write application_state so the agent knows the user is on this run console,
  // and the selected nodeRunId (FRONTEND §0 application-state writes).
  useEffect(() => {
    if (runId) navigate.mutate({ view: "run", id: runId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);
  useEffect(() => {
    if (runId && selectedNodeRunId) {
      navigate.mutate({ view: "run", id: runId });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNodeRunId]);

  // Build the run-overlay canvas model from the live graph (correct-by-
  // construction: reuses the editor's WorkflowCanvas + modelFromGraph layout).
  const canvas = useMemo(
    () => (graph ? runGraphToCanvas(graph) : null),
    [graph],
  );

  const status = summary?.status ?? graph?.status;
  const isRunning = status === "running";
  const isPaused = status === "paused";
  const isTerminal =
    status === "done" || status === "failed" || status === "cancelled";

  const onError = useCallback(
    (e: unknown) => {
      toast.error(e instanceof Error ? e.message : t("runs.controlError"));
    },
    [t],
  );

  // Select a NodeRun (from a Steps/Events row click) → map back to its template
  // node so the canvas highlights it too.
  const selectByNodeRun = useCallback(
    (nodeRunId: string) => {
      const nr = graph?.nodeRuns.find((n) => n.id === nodeRunId);
      if (nr) setSelectedNodeId(nr.nodeId);
    },
    [graph],
  );

  function runAgain() {
    if (!summary?.templateId) return;
    runStart.mutate(
      { templateId: summary.templateId },
      {
        onSuccess: () => toast.success(t("runs.runAgainStarted")),
        onError,
      },
    );
  }

  function onRetry() {
    if (!runId || !selectedNodeRunId) return;
    runRetryNode.mutate(
      { runId, nodeRunId: selectedNodeRunId },
      {
        onSuccess: () => toast.success(t("runs.retryStarted")),
        onError,
      },
    );
  }

  function onOpenSubRun() {
    // The engine inlines subworkflows today; surface a clear message rather than
    // navigating to a run that does not exist as a separate row.
    toast.info(t("runs.subRunInline"));
  }

  if (!runId) return null;

  const events = eventsData?.events ?? [];

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* ── Header bar: title + status + run controls + chips ── */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <Link to="/runs">
              <IconArrowLeft className="size-4" />
              {t("runs.back")}
            </Link>
          </Button>
          <h1 className="truncate font-mono text-sm font-semibold sm:text-base">
            {runId}
          </h1>
          {status ? <RunStatusBadge status={status} /> : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Token-budget chip */}
          {summary ? (
            <span
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs"
              title={t("runs.budget")}
            >
              <IconCoin className="size-3.5 text-muted-foreground" />
              <span className="font-mono">
                {summary.tokensSpent}
                {summary.tokenBudget != null ? ` / ${summary.tokenBudget}` : ""}
              </span>
            </span>
          ) : null}

          {/* Deliverable chip */}
          {summary?.deliverable ? (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
              <IconPackage className="size-3.5" />
              {summary.deliverable.kind}
            </span>
          ) : null}

          {/* run controls (FRONTEND §4 enabled rules) */}
          {isRunning ? (
            <Button
              size="sm"
              variant="outline"
              disabled={runPause.isPending}
              onClick={() => runPause.mutate({ runId }, { onError })}
            >
              <IconPlayerPause className="size-4" />
              {t("runs.pause")}
            </Button>
          ) : null}
          {isPaused ? (
            <Button
              size="sm"
              variant="outline"
              disabled={runResume.isPending}
              onClick={() => runResume.mutate({ runId }, { onError })}
            >
              <IconPlayerPlay className="size-4" />
              {t("runs.resume")}
            </Button>
          ) : null}
          {isRunning || isPaused ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setCancelOpen(true)}
            >
              <IconX className="size-4" />
              {t("runs.cancel")}
            </Button>
          ) : null}
          {isTerminal ? (
            <Button
              size="sm"
              disabled={runStart.isPending || !summary?.templateId}
              onClick={runAgain}
            >
              <IconRefresh className="size-4" />
              {t("runs.runAgain")}
            </Button>
          ) : null}
        </div>
      </header>

      {/* ── Body ── */}
      {graphLoading ? (
        <div className="grid flex-1 gap-4 p-4 lg:grid-cols-[1fr_360px]">
          <Skeleton className="h-full w-full rounded-lg" />
          <Skeleton className="h-full w-full rounded-lg" />
        </div>
      ) : error ? (
        <div className="m-4 rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
          {t("runs.loadError")}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-rows-[1fr_auto] gap-0">
          {/* top: canvas (left) + inspector (right) */}
          <div className="grid min-h-0 gap-0 lg:grid-cols-[1fr_minmax(300px,380px)]">
            {/* live DAG canvas — the shared WorkflowCanvas in run mode */}
            <div className="relative min-h-[260px] min-w-0 border-r border-border">
              {canvas ? (
                <WorkflowCanvas
                  mode="run"
                  model={canvas.model}
                  onModelChange={() => {
                    /* read-only in run mode */
                  }}
                  runStatusByNodeId={canvas.runStatusByNodeId}
                  iterationByNodeId={canvas.iterationByNodeId}
                  dynamicByNodeId={canvas.dynamicByNodeId}
                  onSelectNode={setSelectedNodeId}
                />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  {t("runs.notStarted")}
                </div>
              )}
            </div>

            {/* node inspector */}
            <aside className="min-h-0 min-w-0 overflow-hidden p-3">
              <NodeInspector
                node={node}
                loading={nodeLoading}
                hasSelection={!!selectedNodeRunId}
                pendingRetry={runRetryNode.isPending}
                onRetry={onRetry}
                onOverride={() => setOverrideOpen(true)}
                onViewDiff={() => setDiffOpen(true)}
                onOpenSubRun={onOpenSubRun}
              />
            </aside>
          </div>

          {/* bottom tabs */}
          <div
            className={cn("h-[300px] min-h-0 border-t border-border px-4 py-3")}
          >
            <RunTabs
              summary={summary}
              graph={graph}
              events={events}
              selectedNode={node}
              selectedNodeRunId={selectedNodeRunId}
              onSelectNodeRun={selectByNodeRun}
            />
          </div>
        </div>
      )}

      {/* node-level dialogs */}
      <OverrideDialog
        open={overrideOpen}
        onOpenChange={setOverrideOpen}
        runId={runId}
        node={node ?? null}
        override={nodeOverride}
      />
      <DiffSheet
        open={diffOpen}
        onOpenChange={setDiffOpen}
        nodeTitle={node?.title ?? null}
        diff={node?.diff ?? null}
      />
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={t("dialog.cancelRunTitle")}
        description={t("dialog.cancelRunBody")}
        confirmLabel={t("runs.cancel")}
        pending={runCancel.isPending}
        onConfirm={() =>
          runCancel.mutate(
            { runId },
            {
              onSuccess: () => {
                setCancelOpen(false);
                toast.success(t("board.runCancelled"));
              },
              onError: (e: unknown) => {
                setCancelOpen(false);
                onError(e);
              },
            },
          )
        }
      />
    </div>
  );
}
