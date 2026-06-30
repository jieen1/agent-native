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
  IconChevronRight,
  IconTool,
  IconBrain,
  IconListDetails,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { V3StatusBadge } from "./V3StatusBadge";
import {
  useV3NodeSummary,
  useV3SpawnDetail,
  useV3SpawnEvents,
  type V3Node,
  type V3SpawnEvent,
} from "@/hooks/use-v3-run";
import {
  durationMs,
  fmtDuration,
  fmtTokens,
  fmtDateTime,
  agentPresentation,
  modelDisplay,
} from "./v3-format";

// ── Execution timeline (spawn_events) ────────────────────────────────────────

/** Strip the `mcp__<server>__` prefix off a tool name for display. */
function shortToolName(name: string | null): string {
  if (!name) return "tool";
  const parts = name.split("__");
  return parts[parts.length - 1] || name;
}

/** A tool call routed through an MCP server (rendered with an MCP badge). */
function isMcpTool(name: string | null): boolean {
  return !!name && name.startsWith("mcp__");
}

/** Pretty-print a JSON-ish value for a monospace block. */
function fmtPayload(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** A single tool call: collapsible card with name + input + result. */
function ToolStepCard({ step }: { step: V3SpawnEvent }) {
  const mcp = isMcpTool(step.name);
  const name = shortToolName(step.name);
  const input = fmtPayload(step.input);
  const result = fmtPayload(step.result);
  return (
    <Collapsible>
      <div className="overflow-hidden rounded-md border border-border/60 bg-card">
        <CollapsibleTrigger className="group flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-accent/40">
          <IconChevronRight className="h-3 w-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          <IconTool
            className={cn(
              "h-3.5 w-3.5 shrink-0",
              mcp ? "text-violet-500" : "text-sky-500",
            )}
          />
          <span className="font-mono font-medium">{name}</span>
          {mcp ? (
            <Badge
              variant="secondary"
              className="h-4 px-1.5 text-[10px] font-normal"
            >
              MCP
            </Badge>
          ) : null}
          <span className="ml-auto text-[10px] text-muted-foreground">
            工具调用
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {input.trim() ? (
            <div className="border-t border-border/60">
              <div className="bg-muted/30 px-2.5 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                输入
              </div>
              <pre className="max-h-60 overflow-auto bg-muted/40 px-3 py-2 text-[11px] leading-relaxed">
                {input}
              </pre>
            </div>
          ) : null}
          {result.trim() ? (
            <div className="border-t border-border/60">
              <div className="bg-muted/30 px-2.5 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                结果
              </div>
              <pre className="max-h-60 overflow-auto bg-background px-3 py-2 text-[11px] leading-relaxed">
                {result}
              </pre>
            </div>
          ) : null}
          {!input.trim() && !result.trim() ? (
            <div className="border-t border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
              无输入或结果记录
            </div>
          ) : null}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/**
 * The "执行过程 / Execution" timeline: a vertical rail of the spawn's ordered
 * reasoning text + tool calls + tool results. A `tool_use` immediately followed
 * by its `tool_result` is merged into one card so each call shows its input AND
 * result together.
 */
function ExecutionTimeline({
  events,
  loading,
}: {
  events: V3SpawnEvent[] | undefined;
  loading: boolean;
}) {
  // Merge each tool_result into the preceding tool_use (matched by toolUseId
  // when present, else positionally) so a call renders as one card.
  const items = useMemo(() => {
    const list = events ?? [];
    const out: V3SpawnEvent[] = [];
    for (const ev of list) {
      if (ev.type === "tool_result") {
        // Attach to the most recent tool_use that still lacks a result.
        const prior = [...out]
          .reverse()
          .find((e) => e.type === "tool_use" && e.result == null);
        if (prior) {
          prior.result = ev.result;
          continue;
        }
      }
      out.push({ ...ev });
    }
    return out;
  }, [events]);

  if (loading && (!events || events.length === 0)) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-9 w-full rounded-md" />
        <Skeleton className="h-9 w-11/12 rounded-md" />
        <Skeleton className="h-9 w-4/5 rounded-md" />
      </div>
    );
  }

  if (!items.length) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-muted/10 px-3 py-4 text-center text-xs text-muted-foreground">
        无中间过程记录 / No execution steps recorded
      </div>
    );
  }

  return (
    <ol className="relative">
      {items.map((ev, idx) => {
        const isLast = idx === items.length - 1;
        const isTool = ev.type === "tool_use";
        return (
          <li key={ev.id} className="relative flex gap-3 pb-3">
            {/* Rail + dot */}
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  "z-10 flex size-6 shrink-0 items-center justify-center rounded-full ring-4 ring-background",
                  isTool
                    ? isMcpTool(ev.name)
                      ? "bg-violet-500"
                      : "bg-sky-500"
                    : "bg-emerald-500",
                )}
              >
                {isTool ? (
                  <IconTool className="size-3.5 text-white" />
                ) : (
                  <IconBrain className="size-3.5 text-white" />
                )}
              </span>
              {!isLast ? <span className="w-px flex-1 bg-border" /> : null}
            </div>

            {/* Content */}
            <div className="min-w-0 flex-1 pt-0.5">
              {isTool ? (
                <ToolStepCard step={ev} />
              ) : (
                <div className="whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-foreground/90">
                  {ev.text}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

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
  const { data: spawnEvents, isLoading: eventsLoading } =
    useV3SpawnEvents(spawnId);

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
        <p className="text-sm font-medium text-foreground">未选择节点</p>
        <p className="max-w-[220px] text-xs text-muted-foreground">
          在左侧选择一个节点，查看其智能体提示词、执行过程与产出。
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
            <Stat icon={IconCpu} label="模型" value={model} />
            <Stat icon={IconClockHour3} label="耗时" value={dur} />
            <Stat
              icon={IconArrowDownRight}
              label="输入 Token"
              value={fmtTokens(tokensIn)}
            />
            <Stat
              icon={IconArrowUpRight}
              label="输出 Token"
              value={fmtTokens(tokensOut)}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border bg-card/40 px-3 py-2 text-[11px]">
            <span className="flex items-center gap-1 text-muted-foreground">
              <IconCoin className="size-3" />
              Token 总计
            </span>
            <span className="font-mono font-medium text-foreground">
              {fmtTokens(tokensIn + tokensOut)}
            </span>
          </div>

          {/* Timing */}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className="text-muted-foreground">开始时间</dt>
            <dd className="text-right font-mono text-foreground/80">
              {fmtDateTime(node?.startedAt)}
            </dd>
            <dt className="text-muted-foreground">完成时间</dt>
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
            title="渲染后的提示词"
            body={spawnDetail?.renderedPrompt}
            loading={spawnLoading && !spawnDetail}
            empty="该节点没有记录提示词。"
          />

          {/* Output */}
          <TextBlock
            icon={IconFileText}
            title="产出"
            meta={
              summary?.outputKind
                ? `${summary.outputKind}${summary.truncated ? " · 已截断" : ""}`
                : undefined
            }
            body={summary?.output}
            loading={summaryLoading && !summary}
            empty="该节点没有产生文本产出。"
          />

          {/* Execution timeline (spawn_events) */}
          <section className="flex min-h-0 flex-col">
            <div className="mb-1.5 flex items-center gap-1.5">
              <IconListDetails className="size-3.5 text-muted-foreground" />
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                执行过程 / Execution
              </h4>
              {spawnEvents && spawnEvents.total > 0 ? (
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                  {spawnEvents.total} 步
                </span>
              ) : null}
            </div>
            <ExecutionTimeline
              events={spawnEvents?.events}
              loading={eventsLoading && !spawnEvents}
            />
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}
