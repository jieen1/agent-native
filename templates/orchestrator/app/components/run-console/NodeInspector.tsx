import { useTranslation } from "react-i18next";
import {
  IconCubeSend,
  IconEdit,
  IconGitCommit,
  IconRefresh,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RunStatusBadge } from "@/components/RunStatusBadge";
import type { NodeRunDetail } from "@/hooks/use-runs";
import { cn } from "@/lib/utils";

// Node inspector (FRONTEND §4(b)). Shows node-get's FULL fields for the focused
// NodeRun — status/iteration/fanoutIndex/dynamic/attempts/tokens/timings, the
// executor + runtime (microVM/branch/onFailure), the resolved input + output
// artifact values — plus the per-node action buttons: Re-run (run-retry-node),
// Edit & re-run (node-override / D5), View diff (Sheet), Open sub-run.

export interface NodeInspectorProps {
  node?: NodeRunDetail;
  loading: boolean;
  /** A node is selected but its detail is still loading. */
  hasSelection: boolean;
  pendingRetry: boolean;
  onRetry: () => void;
  onOverride: () => void;
  onViewDiff: () => void;
  onOpenSubRun: () => void;
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function durationMs(start: string | null, end: string | null): string | null {
  if (!start || !end) return null;
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  const ms = b - a;
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function NodeInspector({
  node,
  loading,
  hasSelection,
  pendingRetry,
  onRetry,
  onOverride,
  onViewDiff,
  onOpenSubRun,
}: NodeInspectorProps) {
  const { t } = useTranslation();

  if (!hasSelection) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        {t("runs.selectNode")}
      </div>
    );
  }
  if (loading || !node) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        {t("common.loading")}
      </div>
    );
  }

  const dur = durationMs(node.startedAt, node.completedAt);
  const canRetry = node.status === "failed" || node.status === "done";
  const isSubworkflow = node.type === "subworkflow";

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-border bg-card">
      {/* header */}
      <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{node.title}</p>
          <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
            {node.nodeId} · {node.type}
          </p>
        </div>
        <RunStatusBadge status={node.status} />
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="grid gap-4 p-4 text-sm">
          {/* routing */}
          <Section title={t("runs.sectionRouting")}>
            {node.engine ? (
              <Field label={t("runs.executor")} value={node.engine} mono />
            ) : null}
            {node.model ? (
              <Field label={t("runs.model")} value={node.model} mono />
            ) : null}
            {node.assignee ? (
              <Field label={t("runs.assignee")} value={node.assignee} mono />
            ) : null}
          </Section>

          {/* progress counters */}
          <Section title={t("runs.sectionProgress")}>
            <div className="grid grid-cols-3 gap-2">
              <Field
                label={t("runs.iteration")}
                value={String(node.iteration)}
                mono
              />
              <Field
                label={t("runs.fanoutIndex")}
                value={String(node.fanoutIndex)}
                mono
              />
              <Field
                label={t("runs.attempts")}
                value={String(node.attempts)}
                mono
              />
            </div>
            <Field
              label={t("runs.tokensSpent")}
              value={String(node.tokensSpent)}
              mono
            />
            <Field label={t("runs.started")} value={fmt(node.startedAt)} />
            <Field label={t("runs.completed")} value={fmt(node.completedAt)} />
            {dur ? <Field label={t("runs.duration")} value={dur} mono /> : null}
            {node.dynamic ? (
              <span className="inline-flex w-fit items-center rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
                {t("runs.dynamic")}
              </span>
            ) : null}
          </Section>

          {/* runtime (virtual env) — P2 batch */}
          {node.runtime ? (
            <Section title={t("runs.sectionRuntime")}>
              <Field
                label={t("runs.runtimeKind")}
                value={node.runtime.kind}
                mono
              />
              {node.runtime.image ? (
                <Field
                  label={t("runs.runtimeImage")}
                  value={node.runtime.image}
                  mono
                />
              ) : null}
              <Field
                label={t("runs.runtimeBranch")}
                value={node.runtime.branch}
                mono
              />
              <Field
                label={t("runs.runtimeOnFailure")}
                value={node.runtime.onFailure}
                mono
              />
            </Section>
          ) : null}

          {/* error */}
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

          {/* input artifact */}
          <div className="grid gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t("runs.input")}
            </span>
            <pre className="max-h-40 overflow-auto rounded bg-muted/50 p-2 text-xs">
              {node.input != null
                ? JSON.stringify(node.input, null, 2)
                : t("runs.noInput")}
            </pre>
          </div>

          {/* output artifact */}
          <div className="grid gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t("runs.output")}
            </span>
            <pre className="max-h-56 overflow-auto rounded bg-muted/50 p-2 text-xs">
              {node.output != null
                ? JSON.stringify(node.output, null, 2)
                : t("runs.noOutput")}
            </pre>
          </div>
        </div>
      </ScrollArea>

      {/* per-node action buttons */}
      <div className="flex flex-wrap gap-2 border-t border-border px-4 py-3">
        <Button
          size="sm"
          variant="outline"
          disabled={!canRetry || pendingRetry}
          onClick={onRetry}
        >
          <IconRefresh
            className={cn("size-4", pendingRetry && "animate-spin")}
          />
          {t("runs.retryNode")}
        </Button>
        <Button size="sm" variant="outline" onClick={onOverride}>
          <IconEdit className="size-4" />
          {t("runs.editRerun")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onViewDiff}>
          <IconGitCommit className="size-4" />
          {t("runs.viewDiff")}
        </Button>
        {isSubworkflow ? (
          <Button size="sm" variant="ghost" onClick={onOpenSubRun}>
            <IconCubeSend className="size-4" />
            {t("runs.openSubRun")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </span>
      {children}
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("truncate text-xs", mono && "font-mono")}>
        {value}
      </span>
    </div>
  );
}
