import { useMemo } from "react";
import {
  IconRobot,
  IconCpu,
  IconClockHour3,
  IconCoin,
  IconArrowDownRight,
  IconArrowUpRight,
  IconFileText,
  IconMessageCircle,
  IconAlertTriangle,
  IconPointerSearch,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { V3StatusBadge } from "./V3StatusBadge";
import {
  useV3NodeSummary,
  useV3SpawnDetail,
  type V3Node,
} from "@/hooks/use-v3-run";
import {
  durationMs,
  fmtDuration,
  fmtTokens,
  fmtDateTime,
  agentPresentation,
  modelDisplay,
} from "./v3-format";

// ── Small stat tile ──────────────────────────────────────────────────────────

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof IconCpu;
  label: string;
  value: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-border bg-card/40 px-3 py-2">
      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <Icon className="size-3" />
        {label}
      </span>
      <span className="truncate font-mono text-sm font-medium text-foreground">
        {value}
      </span>
    </div>
  );
}

// ── Text content block (prompt / output) ─────────────────────────────────────

function TextBlock({
  icon: Icon,
  title,
  meta,
  body,
  empty,
  loading,
}: {
  icon: typeof IconFileText;
  title: string;
  meta?: string;
  body: string | null | undefined;
  empty: string;
  loading?: boolean;
}) {
  return (
    <section className="flex min-h-0 flex-col">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Icon className="size-3.5 text-muted-foreground" />
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h4>
        {meta ? (
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
            {meta}
          </span>
        ) : null}
      </div>
      {loading ? (
        <div className="space-y-1.5 rounded-lg border border-border bg-muted/30 p-3">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-11/12" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      ) : body && body.trim() ? (
        <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/30 p-3 text-xs leading-relaxed text-foreground/90">
          {body}
        </pre>
      ) : (
        <div className="rounded-lg border border-dashed border-border bg-muted/10 px-3 py-4 text-center text-xs text-muted-foreground">
          {empty}
        </div>
      )}
    </section>
  );
}

// ── NodeInspector ────────────────────────────────────────────────────────────

export interface NodeInspectorProps {
  runId: string;
  /** The resolved runtime node for the selected DAG node. */
  node: V3Node | null | undefined;
  /** The DAG-level node id (for the title before the runtime node resolves). */
  dagNodeId: string | null;
  /** Agent declared on the DAG node, if any. */
  dagAgent: string | null;
  hasSelection: boolean;
}

export function NodeInspector({
  runId,
  node,
  dagNodeId,
  dagAgent,
  hasSelection,
}: NodeInspectorProps) {
  const { data: summary, isLoading: summaryLoading } = useV3NodeSummary(
    runId,
    node?.id,
  );

  const spawnId = summary?.spawn?.id ?? null;
  const { data: spawnDetail, isLoading: spawnLoading } =
    useV3SpawnDetail(spawnId);

  const agentLabel = useMemo(
    () =>
      agentPresentation(summary?.spawn?.agentName ?? dagAgent),
    [summary?.spawn?.agentName, dagAgent],
  );

  // ── Empty state ──
  if (!hasSelection) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <div className="rounded-full bg-muted/50 p-3">
          <IconPointerSearch className="size-6 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium text-foreground">No node selected</p>
        <p className="max-w-[220px] text-xs text-muted-foreground">
          Pick a node on the left to read its agent prompt and the output it
          produced.
        </p>
      </div>
    );
  }

  const status = node?.status ?? "pending";
  const dur = fmtDuration(durationMs(node?.startedAt, node?.completedAt));
  const tokensIn = summary?.spawn?.tokensInput ?? 0;
  const tokensOut = summary?.spawn?.tokensOutput ?? 0;
  const model = modelDisplay({
    modelRef: summary?.spawn?.modelRef,
    runtime: summary?.spawn?.runtime,
    engineRef: summary?.spawn?.engineRef,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <header className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <IconRobot className="size-4 text-muted-foreground" />
          <h3 className="truncate font-mono text-sm font-semibold text-foreground">
            {node?.nodeIdInDag ?? dagNodeId}
          </h3>
          <div className="ml-auto">
            <V3StatusBadge status={status} />
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Badge
            variant="outline"
            className={cn("h-5 px-1.5 text-[11px]", agentLabel.className)}
          >
            {agentLabel.label}
          </Badge>
          {summary?.type ? (
            <Badge variant="secondary" className="h-5 px-1.5 font-mono text-[11px]">
              {summary.type}
            </Badge>
          ) : null}
          {summary && (summary.iteration > 0 || summary.fanoutIndex > 0) ? (
            <span className="font-mono text-[11px] text-muted-foreground">
              {summary.iteration > 0 ? `iter ${summary.iteration}` : ""}
              {summary.fanoutIndex > 0 ? ` · #${summary.fanoutIndex}` : ""}
            </span>
          ) : null}
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-4">
          {/* Stats grid */}
          <div className="grid grid-cols-2 gap-2">
            <Stat icon={IconCpu} label="Model" value={model} />
            <Stat icon={IconClockHour3} label="Duration" value={dur} />
            <Stat
              icon={IconArrowDownRight}
              label="Input tokens"
              value={fmtTokens(tokensIn)}
            />
            <Stat
              icon={IconArrowUpRight}
              label="Output tokens"
              value={fmtTokens(tokensOut)}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border bg-card/40 px-3 py-2 text-[11px]">
            <span className="flex items-center gap-1 text-muted-foreground">
              <IconCoin className="size-3" />
              Total tokens
            </span>
            <span className="font-mono font-medium text-foreground">
              {fmtTokens(tokensIn + tokensOut)}
            </span>
          </div>

          {/* Timing */}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Started</dt>
            <dd className="text-right font-mono text-foreground/80">
              {fmtDateTime(node?.startedAt)}
            </dd>
            <dt className="text-muted-foreground">Completed</dt>
            <dd className="text-right font-mono text-foreground/80">
              {fmtDateTime(node?.completedAt)}
            </dd>
          </dl>

          {/* Error */}
          {node?.error || summary?.error ? (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-xs text-red-600 dark:text-red-400">
              <IconAlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span className="break-words">{node?.error ?? summary?.error}</span>
            </div>
          ) : null}

          <Separator />

          {/* Rendered prompt */}
          <TextBlock
            icon={IconMessageCircle}
            title="Rendered prompt"
            body={spawnDetail?.renderedPrompt}
            loading={spawnLoading && !spawnDetail}
            empty="No prompt recorded for this node."
          />

          {/* Output */}
          <TextBlock
            icon={IconFileText}
            title="Output"
            meta={
              summary?.outputKind
                ? `${summary.outputKind}${summary.truncated ? " · truncated" : ""}`
                : undefined
            }
            body={summary?.output}
            loading={summaryLoading && !summary}
            empty="This node produced no text output."
          />
        </div>
      </ScrollArea>
    </div>
  );
}
