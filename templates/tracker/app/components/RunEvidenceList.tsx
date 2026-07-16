import type {
  ActivityResponse,
  OrchestratorRun,
  WorkItemRunSummary,
} from "@shared/types";
/**
 * "关联运行" evidence — for each of a work item's dispatched runs, show the
 * existing orchestrator deep link PLUS a compact real-data summary: the
 * run's own status, a mini node-count map (done/failed/total), and a
 * "查看完整转录" deep link into the orchestrator run page.
 *
 * Data source: the SAME `get-activity` payload the page already polls while
 * a work item is dispatched (`useActivity`, 4s cadence) — it fetches each
 * tagged run's DAG node statuses via the orchestrator's `v3RunNodes` action
 * (see get-activity.ts). No extra orchestrator round trip is added here.
 *
 * Known gap (investigated, not fabricated): neither `get-activity` nor any
 * orchestrator run/node read action (`runState`, `runSummary`, `nodeSummary`,
 * `v3RunNodes`) exposes a real retry count. `v3_nodes.iteration` is the DAG
 * loop-body counter (design/develop/review convergence), not a manual-retry
 * counter — `nodeRetry` resets a node in place without bumping it or leaving
 * a trace. `v3_spawns.attempt` is hardcoded to 1 at every insert site
 * (v3-dispatcher.ts), never incremented, so it carries no real attempt count
 * either. There is therefore no honest "重试次数" to render — this
 * deliberately shows node/status evidence only, not a retry figure.
 *
 * A run not yet correlated (older redispatch outside get-activity's tag-match
 * window, or the brain hasn't propagated tags to `workflowRun` yet — a known
 * best-effort dependency, see dispatch-to-orchestrator.ts) degrades to the
 * plain deep link rather than a fabricated count.
 */
import { IconExternalLink, IconFileText } from "@tabler/icons-react";

import {
  fmtDateTime,
  nodeStatusPresentation,
  orchestratorRunHref,
} from "@/components/tracker-format";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

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

interface RunEvidenceMiniMapProps {
  runId: string;
  activity: ActivityResponse | undefined;
  activityLoading: boolean;
}

/** One run's compact DAG evidence: status + node mini-map + transcript link. */
export function RunEvidenceMiniMap({
  runId,
  activity,
  activityLoading,
}: RunEvidenceMiniMapProps) {
  if (activityLoading && !activity) {
    return (
      <Skeleton className="h-4 w-40" data-testid="run-evidence-skeleton" />
    );
  }

  const matched: OrchestratorRun | undefined = activity?.runs?.find(
    (r) => r.id === runId,
  );
  const readErr = activity?.errors?.runs;

  if (!matched) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-muted-foreground/70" title={readErr}>
          {readErr ? "节点状态读取失败" : "暂无节点数据"}
        </span>
        <TranscriptLink runId={runId} />
      </div>
    );
  }

  const nodes = matched.nodes ?? [];
  const total = nodes.length;
  const done = nodes.filter((n) => n.status === "done").length;
  const failed = nodes.filter(
    (n) => n.status === "failed" || n.status === "cancelled",
  ).length;
  const runStatus = nodeStatusPresentation(matched.status);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
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
        {matched.status}
      </Badge>
      {total > 0 ? (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5">
                <Progress value={(done / total) * 100} className="h-1.5 w-12" />
                <span className="font-mono text-[11px] text-muted-foreground">
                  {done}/{total} 节点
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="left">
              <span className="text-xs">
                {done} 完成 · {failed} 失败 · 共 {total} 节点
              </span>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <span className="text-[11px] text-muted-foreground/70">
          DAG 尚未产生节点
        </span>
      )}
      {failed > 0 ? (
        <Badge
          variant="outline"
          className="h-4 gap-1 px-1 text-[10px] bg-red-500/10 text-red-600 border-red-500/30 dark:text-red-400"
        >
          失败 {failed}
        </Badge>
      ) : null}
      <TranscriptLink runId={runId} />
    </div>
  );
}

export interface RunEvidenceListProps {
  runs: WorkItemRunSummary[];
  activity: ActivityResponse | undefined;
  activityLoading: boolean;
}

/** The full "关联运行" list: existing deep link + branch + date per row, plus
 *  the new evidence mini-map. Renders nothing when the item has no runs. */
export function RunEvidenceList({
  runs,
  activity,
  activityLoading,
}: RunEvidenceListProps) {
  if (runs.length === 0) return null;

  return (
    <ul className="flex flex-col gap-1.5">
      {runs.map((r, i) => (
        <li
          key={`${r.runId ?? "pending"}-${r.dispatchedAt}-${i}`}
          className={cn(
            "flex flex-col gap-1 text-xs",
            r.superseded && "text-muted-foreground/60",
          )}
        >
          <div
            className={cn(
              "flex flex-wrap items-center gap-1.5",
              r.superseded && "line-through",
            )}
          >
            {r.runId ? (
              <a
                href={orchestratorRunHref(r.runId)}
                className={cn(
                  "flex items-center gap-1 font-mono hover:underline",
                  !r.superseded && "text-foreground/80 hover:text-foreground",
                )}
              >
                {r.runId.slice(0, 12)}…
                <IconExternalLink className="size-3 shrink-0 opacity-60" />
              </a>
            ) : (
              <span className="font-mono">等待运行 id 回填</span>
            )}
            {r.branch ? (
              <span className="font-mono text-muted-foreground">
                · {r.branch}
              </span>
            ) : null}
            <span className="text-muted-foreground">
              · {fmtDateTime(r.dispatchedAt)}
            </span>
            {r.superseded ? (
              <Badge variant="outline" className="h-4 px-1 text-[10px]">
                已重派
              </Badge>
            ) : null}
          </div>
          {r.runId ? (
            <RunEvidenceMiniMap
              runId={r.runId}
              activity={activity}
              activityLoading={activityLoading}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}
