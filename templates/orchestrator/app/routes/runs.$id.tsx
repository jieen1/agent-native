import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { useTranslation } from "react-i18next";
import {
  IconArrowLeft,
  IconBolt,
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
  useRunGet,
  useRunGraph,
  type RunGraphNode,
} from "@/hooks/use-runs";
import { RunStatusBadge } from "@/components/RunStatusBadge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function meta() {
  return [{ title: `${APP_TITLE} — Run` }];
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/** Tint a node-list row by its status (FRONTEND §4: pending grey / running blue
 *  / done green / failed red / skipped dashed). */
const ROW_TINT: Record<string, string> = {
  pending: "border-border",
  ready: "border-amber-500/40",
  running: "border-blue-500/50 bg-blue-500/5",
  done: "border-emerald-500/40",
  failed: "border-red-500/50 bg-red-500/5",
  skipped: "border-dashed border-border opacity-60",
  "awaiting-approval": "border-orange-500/50 bg-orange-500/5",
};

export default function RunConsoleRoute() {
  const { t } = useTranslation();
  const { id: runId } = useParams();
  const [selectedNodeRunId, setSelectedNodeRunId] = useState<string | null>(
    null,
  );

  const { data: graph, isLoading: graphLoading, error } = useRunGraph(runId);
  const { data: summary } = useRunGet(runId);
  const { data: node } = useNodeRun(runId, selectedNodeRunId ?? undefined);
  const { runStart, runPause, runResume, runCancel } = useRunControls();
  const navigate = useActionMutation("navigate", {});

  // Write application_state so the agent knows the user is on this run console
  // (DESIGN §2a / context-awareness). Re-run when the run id changes.
  useEffect(() => {
    if (runId) navigate.mutate({ view: "run", id: runId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const status = summary?.status ?? graph?.status;
  const isRunning = status === "running";
  const isPaused = status === "paused";
  const isTerminal =
    status === "done" || status === "failed" || status === "cancelled";

  function onError(e: unknown) {
    toast.error(e instanceof Error ? e.message : t("runs.controlError"));
  }

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

  if (!runId) return null;

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col px-4 py-6 sm:px-6 sm:py-8">
      {/* ── Header bar: title + status + run controls ── */}
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
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
        <div className="flex items-center gap-2">
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
              disabled={runCancel.isPending}
              onClick={() => runCancel.mutate({ runId }, { onError })}
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

      {/* ── Overview strip ── */}
      {summary ? (
        <div className="mb-5 grid grid-cols-2 gap-3 rounded-lg border border-border bg-card p-4 text-sm sm:grid-cols-4">
          <Stat
            label={t("runs.tokensSpent")}
            value={String(summary.tokensSpent)}
          />
          <Stat
            label={t("runs.budgetRemaining")}
            value={
              summary.budgetRemaining == null
                ? "∞"
                : String(summary.budgetRemaining)
            }
          />
          <Stat label={t("runs.started")} value={fmt(summary.startedAt)} />
          <Stat label={t("runs.completed")} value={fmt(summary.completedAt)} />
        </div>
      ) : null}

      {/* ── Body: node list (left) + inspector (right) ── */}
      {graphLoading ? (
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      ) : error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
          {t("runs.loadError")}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[1fr_minmax(280px,360px)]">
          {/* Node list */}
          <section className="min-w-0">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("runs.nodes")}
            </h2>
            <ul className="grid gap-1.5">
              {(graph?.nodeRuns ?? []).map((nr) => (
                <NodeRow
                  key={nr.id}
                  node={nr}
                  selected={nr.id === selectedNodeRunId}
                  onSelect={() => setSelectedNodeRunId(nr.id)}
                />
              ))}
            </ul>
          </section>

          {/* Inspector */}
          <aside className="min-w-0">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("runs.nodeDetail")}
            </h2>
            {!selectedNodeRunId ? (
              <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                {t("runs.selectNode")}
              </div>
            ) : !node ? (
              <p className="text-sm text-muted-foreground">
                {t("common.loading")}
              </p>
            ) : (
              <div className="grid gap-3 rounded-lg border border-border bg-card p-4 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{node.title}</span>
                  <RunStatusBadge status={node.status} />
                </div>
                <Field label={t("runs.type")} value={node.type} />
                {node.engine ? (
                  <Field label={t("runs.engine")} value={node.engine} />
                ) : null}
                {node.model ? (
                  <Field label={t("runs.model")} value={node.model} />
                ) : null}
                {node.assignee ? (
                  <Field label={t("runs.assignee")} value={node.assignee} />
                ) : null}
                <div className="grid grid-cols-3 gap-2">
                  <Field
                    label={t("runs.iteration")}
                    value={String(node.iteration)}
                  />
                  <Field
                    label={t("runs.fanoutIndex")}
                    value={String(node.fanoutIndex)}
                  />
                  <Field
                    label={t("runs.attempts")}
                    value={String(node.attempts)}
                  />
                </div>
                <Field
                  label={t("runs.tokensSpent")}
                  value={String(node.tokensSpent)}
                />
                <Field label={t("runs.started")} value={fmt(node.startedAt)} />
                <Field
                  label={t("runs.completed")}
                  value={fmt(node.completedAt)}
                />
                {node.error ? (
                  <div className="grid gap-1">
                    <span className="text-xs font-medium text-destructive">
                      {t("runs.error")}
                    </span>
                    <pre className="overflow-x-auto rounded bg-destructive/5 p-2 text-xs text-destructive">
                      {node.error}
                    </pre>
                  </div>
                ) : null}
                <div className="grid gap-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("runs.output")}
                  </span>
                  <pre className="max-h-64 overflow-auto rounded bg-muted/50 p-2 text-xs">
                    {node.output != null
                      ? JSON.stringify(node.output, null, 2)
                      : t("runs.noOutput")}
                  </pre>
                </div>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-sm font-medium">{value}</p>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate font-mono text-xs">{value}</span>
    </div>
  );
}

function NodeRow({
  node,
  selected,
  onSelect,
}: {
  node: RunGraphNode;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-2 text-left transition-colors hover:bg-accent/40",
          ROW_TINT[node.status] ?? "border-border",
          selected && "ring-2 ring-ring",
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{node.title}</span>
            {node.dynamic ? (
              <IconBolt
                className="size-3.5 shrink-0 text-amber-500"
                aria-label={t("runs.dynamic")}
              />
            ) : null}
          </span>
          <span className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <span>{node.nodeId}</span>
            <span>· {node.type}</span>
            {node.iteration > 0 ? (
              <span>
                · {t("runs.iteration")} {node.iteration}
              </span>
            ) : null}
            {node.fanoutIndex > 0 ? (
              <span>
                · {t("runs.fanoutIndex")} {node.fanoutIndex}
              </span>
            ) : null}
          </span>
        </span>
        <RunStatusBadge status={node.status} />
      </button>
    </li>
  );
}
