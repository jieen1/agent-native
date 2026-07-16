import type {
  ActivityResponse,
  OrchestratorRun,
  OrchestratorRunNode,
  WorkItemRunSummary,
} from "@shared/types";
/**
 * "关联运行" evidence — matches the "执行记录" block in
 * docs/sdlc-product-design/prototypes/s4-work-item.html (~414-462): a real
 * node chain (not an aggregate count), the failing node's raw error text, and
 * a collapsed history of prior run attempts. Expressed with this project's
 * own component vocabulary (shadcn Badge/Collapsible + nodeStatusPresentation
 * tones) rather than the prototype's `.md-node`/`.md-link` CSS.
 *
 * Data source: the SAME `get-activity` payload the page already polls while
 * a work item is dispatched (`useActivity`, 4s cadence) — it fetches each
 * tagged run's DAG node statuses via the orchestrator's `v3RunNodes` action
 * (see get-activity.ts). No extra orchestrator round trip is added here.
 *
 * Known gap (investigated, not fabricated): neither `get-activity` nor any
 * orchestrator run/node read action (`runState`, `runSummary`, `nodeSummary`,
 * `v3RunNodes`) exposes a real retry count or `errorClass`. `v3_nodes.iteration`
 * is the DAG loop-body counter (design/develop/review convergence), not a
 * manual-retry counter — `nodeRetry` resets a node in place without bumping it
 * or leaving a trace. `v3_spawns.attempt` is hardcoded to 1 at every insert
 * site (v3-dispatcher.ts), never incremented. `v3RunNodes` also does not
 * return `errorClass` (only nodeSummary's per-spawn detail does, one node at a
 * time — not worth an extra call per node just for a badge). There is
 * therefore no honest "重试次数" or "errorClass" badge to render here.
 *
 * A run not yet correlated (older redispatch outside get-activity's tag-match
 * window, or the brain hasn't propagated tags to `workflowRun` yet — a known
 * best-effort dependency, see dispatch-to-orchestrator.ts) degrades to the
 * plain deep link rather than a fabricated node chain.
 */
import {
  IconAlertTriangle,
  IconChevronRight,
  IconCircleCheck,
  IconCircleX,
  IconExternalLink,
  IconFileText,
  IconLoader2,
} from "@tabler/icons-react";

import {
  fmtDateTime,
  nodeStatusPresentation,
  orchestratorRunHref,
} from "@/components/tracker-format";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const RUN_STATUS_LABEL: Record<string, string> = {
  done: "成功",
  failed: "失败",
  cancelled: "已取消",
  running: "运行中",
  pending: "等待中",
  paused: "已暂停",
};

function TranscriptLink({ runId }: { runId: string }) {
  return (
    <a
      href={orchestratorRunHref(runId)}
      className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
    >
      <IconFileText className="size-3 shrink-0 opacity-60" />
      查看完整转录
      <IconExternalLink className="size-2.5 shrink-0 opacity-60" />
    </a>
  );
}

// success/running (emerald/blue below) have no `--success`/`--info` token in
// this template's app/global.css (only `--destructive` is defined) — kept
// literal pending a real token; failed/cancelled uses the real `--destructive`
// token since one exists.
function NodeStatusIcon({ status }: { status: string }) {
  if (status === "done") {
    return <IconCircleCheck className="size-3.5 text-success" />;
  }
  if (status === "running") {
    return <IconLoader2 className="size-3.5 animate-spin text-info" />;
  }
  if (status === "failed" || status === "cancelled") {
    return <IconCircleX className="size-3.5 text-destructive" />;
  }
  const dot = nodeStatusPresentation(status).dot;
  return <span className={cn("size-1.5 rounded-full", dot)} />;
}

/** The real node-by-node DAG chain (reproduce → fix → regression → …), not an
 *  aggregate progress bar — mirrors the prototype's `.minidag`. */
function RunNodeChain({ nodes }: { nodes: OrchestratorRunNode[] }) {
  if (nodes.length === 0) {
    return (
      <span className="text-[11px] text-muted-foreground/70">
        DAG 尚未产生节点
      </span>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {nodes.map((node, i) => {
        const pres = nodeStatusPresentation(node.status);
        const prevDone = i > 0 && nodes[i - 1]!.status === "done";
        return (
          <div
            key={`${node.nodeIdInDag}-${i}`}
            className="flex items-center gap-1"
          >
            {i > 0 ? (
              <IconChevronRight
                className={cn(
                  "size-3 shrink-0",
                  prevDone ? "text-success" : "text-muted-foreground/30",
                )}
              />
            ) : null}
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
                pres.chip,
              )}
              title={node.error ?? node.status}
            >
              <NodeStatusIcon status={node.status} />
              <span className="font-mono">{node.nodeIdInDag}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Nodes that failed/were cancelled AND carry raw error text — the single
 *  filter rule behind the "证据文本块". Exported so other surfaces (e.g. the
 *  Inbox failed-routing card) can decide whether to render an evidence
 *  section at all without re-implementing this predicate. */
export function failingNodesOf(
  nodes: OrchestratorRunNode[],
): OrchestratorRunNode[] {
  return nodes.filter(
    (n) => (n.status === "failed" || n.status === "cancelled") && n.error,
  );
}

/** Raw error text for any failed/cancelled node — the "证据文本块". Shown in
 *  full (never truncated to an unreadable single line). */
export function FailureEvidence({ nodes }: { nodes: OrchestratorRunNode[] }) {
  const failing = failingNodesOf(nodes);
  if (failing.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {failing.map((n, i) => (
        <div
          key={`${n.nodeIdInDag}-${i}`}
          className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2"
        >
          <IconAlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <code className="block whitespace-pre-wrap break-all font-mono text-[11px] text-foreground/90">
              {n.error}
            </code>
            <span className="mt-1 block text-[10px] text-muted-foreground">
              节点 {n.nodeIdInDag} 失败
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Shared header line: runId deep link + branch + dispatch time (+ superseded
 *  badge for a history row, or a live status badge for the current row). */
function RunHeaderLine({
  run,
  statusBadge,
  dim,
}: {
  run: WorkItemRunSummary;
  statusBadge?: { status: string } | null;
  dim?: boolean;
}) {
  const runStatus = statusBadge
    ? nodeStatusPresentation(statusBadge.status)
    : null;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1.5 text-xs",
        dim && "text-muted-foreground/60",
      )}
    >
      {run.runId ? (
        <a
          href={orchestratorRunHref(run.runId)}
          className={cn(
            "flex items-center gap-1 font-mono hover:underline",
            !dim && "text-foreground/80 hover:text-foreground",
            dim && "line-through",
          )}
        >
          {run.runId.slice(0, 12)}…
          <IconExternalLink className="size-3 shrink-0 opacity-60" />
        </a>
      ) : (
        <span className="font-mono">等待运行 id 回填</span>
      )}
      {run.branch ? (
        <span
          className={cn(
            "font-mono text-muted-foreground",
            dim && "line-through",
          )}
        >
          · {run.branch}
        </span>
      ) : null}
      <span className={cn("text-muted-foreground", dim && "line-through")}>
        · {fmtDateTime(run.dispatchedAt)}
      </span>
      {runStatus ? (
        <Badge
          variant="outline"
          className={cn("h-4 gap-1 px-1 text-[10px]", runStatus.chip)}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              runStatus.dot,
              runStatus.live && "animate-pulse",
            )}
          />
          {RUN_STATUS_LABEL[statusBadge!.status] ?? statusBadge!.status}
        </Badge>
      ) : null}
      {run.superseded ? (
        <Badge variant="outline" className="h-4 px-1 text-[10px]">
          已重派
        </Badge>
      ) : null}
    </div>
  );
}

/**
 * Compact run reference — the Inspector's "关联运行" row (`.proprow`) in the
 * prototype only shows a small `.runbadge` (status icon + run id + external
 * link), NOT the full node chain / evidence / history that
 * `CurrentRunPanel` renders for the page's main "执行记录" section. This is
 * that compact form, reusing the same `nodeStatusPresentation` tone
 * vocabulary as the rest of this file instead of inventing a new one. */
export function RunBadgeCompact({
  run,
  activity,
}: {
  run: WorkItemRunSummary;
  activity: ActivityResponse | undefined;
}) {
  if (!run.runId) {
    return (
      <span className="text-xs text-muted-foreground">
        等待运行 id 回填
      </span>
    );
  }
  const matched = activity?.runs?.find((r) => r.id === run.runId);
  const pres = matched ? nodeStatusPresentation(matched.status) : null;
  return (
    <a
      href={orchestratorRunHref(run.runId)}
      className="inline-flex items-center gap-1.5 rounded-md border border-border px-1.5 py-0.5 font-mono text-xs text-foreground/80 hover:border-foreground/40 hover:text-foreground"
    >
      {pres ? (
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            pres.dot,
            pres.live && "animate-pulse",
          )}
        />
      ) : null}
      {run.runId.slice(0, 12)}…
      <IconExternalLink className="size-3 shrink-0 opacity-60" />
    </a>
  );
}

interface CurrentRunPanelProps {
  run: WorkItemRunSummary;
  activity: ActivityResponse | undefined;
  activityLoading: boolean;
}

/** The current (most recent, non-superseded) run: header + real node chain +
 *  failure evidence + transcript link. */
function CurrentRunPanel({
  run,
  activity,
  activityLoading,
}: CurrentRunPanelProps) {
  if (!run.runId) {
    return <RunHeaderLine run={run} />;
  }

  if (activityLoading && !activity) {
    return (
      <div className="flex flex-col gap-1.5">
        <RunHeaderLine run={run} />
        <Skeleton
          className="h-5 w-full max-w-56"
          data-testid="run-evidence-skeleton"
        />
      </div>
    );
  }

  const matched: OrchestratorRun | undefined = activity?.runs?.find(
    (r) => r.id === run.runId,
  );
  const readErr = activity?.errors?.runs;

  if (!matched) {
    return (
      <div className="flex flex-col gap-1.5">
        <RunHeaderLine run={run} />
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className="text-[11px] text-muted-foreground/70"
            title={readErr}
          >
            {readErr ? "节点状态读取失败" : "暂无节点数据"}
          </span>
          <TranscriptLink runId={run.runId} />
        </div>
      </div>
    );
  }

  const nodes = matched.nodes ?? [];
  return (
    <div className="flex flex-col gap-1.5">
      <RunHeaderLine run={run} statusBadge={{ status: matched.status }} />
      <RunNodeChain nodes={nodes} />
      <FailureEvidence nodes={nodes} />
      <TranscriptLink runId={run.runId} />
    </div>
  );
}

/** One collapsed "历史运行" row: header line only, no node chain — the
 *  prototype keeps history compact (a single line per prior attempt). */
function HistoryRunRow({
  run,
  activity,
}: {
  run: WorkItemRunSummary;
  activity: ActivityResponse | undefined;
}) {
  const matched = run.runId
    ? activity?.runs?.find((r) => r.id === run.runId)
    : undefined;
  return (
    <div className="rounded-md border border-border px-2.5 py-2">
      <RunHeaderLine
        run={run}
        statusBadge={matched ? { status: matched.status } : null}
        dim
      />
    </div>
  );
}

export interface RunEvidenceListProps {
  runs: WorkItemRunSummary[];
  activity: ActivityResponse | undefined;
  activityLoading: boolean;
}

/** Current run's full evidence panel, plus a collapsed "历史运行 (N)" section
 *  for the rest. Renders nothing when the item has no runs. */
export function RunEvidenceList({
  runs,
  activity,
  activityLoading,
}: RunEvidenceListProps) {
  if (runs.length === 0) return null;

  const current = runs.find((r) => !r.superseded) ?? runs[0]!;
  const history = runs.filter((r) => r !== current);

  return (
    <div className="flex flex-col gap-2.5">
      <CurrentRunPanel
        run={current}
        activity={activity}
        activityLoading={activityLoading}
      />
      {history.length > 0 ? (
        <Collapsible>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="group flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <IconChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
              历史运行 ({history.length})
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-1.5 flex flex-col gap-1.5">
            {history.map((r, i) => (
              <HistoryRunRow
                key={`${r.runId ?? "pending"}-${r.dispatchedAt}-${i}`}
                run={r}
                activity={activity}
              />
            ))}
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}
