import { useActionMutation } from "@agent-native/core/client";
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
  IconHistory,
  IconRotate,
  IconPlayerSkipForward,
  IconEdit,
  IconShieldLock,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  useV3NodeSummary,
  useV3SpawnDetail,
  useV3SpawnEvents,
  useV3NodeSpawnHistory,
  type V3Node,
  type V3DagNode,
  type V3SpawnEvent,
  type V3NodeSpawnLogEntry,
} from "@/hooks/use-v3-run";
import { cn } from "@/lib/utils";

import { StatusMarker } from "./StatusMarker";
import {
  durationMs,
  fmtDuration,
  fmtTokens,
  fmtLatency,
  fmtDateTime,
  agentPresentation,
  modelDisplay,
} from "./v3-format";
import { V3StatusBadge } from "./V3StatusBadge";

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

// ── Attempt timeline (all spawns for this node — retries included) ──────────

function AttemptRow({ spawn }: { spawn: V3NodeSpawnLogEntry }) {
  const tokensTotal = (spawn.tokensInput ?? 0) + (spawn.tokensOutput ?? 0);
  const dur =
    spawn.latencyMs != null
      ? fmtLatency(spawn.latencyMs)
      : fmtDuration(durationMs(spawn.startedAt, spawn.completedAt));
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs",
        spawn.status === "failed"
          ? "border-destructive/30 bg-destructive/[0.04]"
          : "border-border",
      )}
    >
      <StatusMarker status={spawn.status} size="sm" ringSize={14} />
      <span className="font-medium text-foreground">
        Attempt {spawn.attempt}
      </span>
      {spawn.errorClass ? (
        <Badge
          variant="outline"
          className="h-4.5 border-amber-500/40 px-1.5 text-[10px] text-amber-600 dark:text-amber-400"
        >
          {spawn.errorClass}
        </Badge>
      ) : null}
      {spawn.error ? (
        <span
          className="max-w-[160px] truncate text-[11px] text-muted-foreground"
          title={spawn.error}
        >
          {spawn.error}
        </span>
      ) : null}
      <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[10.5px] text-muted-foreground">
        {fmtTokens(tokensTotal)} tok · {dur}
      </span>
    </div>
  );
}

function AttemptTimeline({
  history,
  loading,
}: {
  history: { spawns: V3NodeSpawnLogEntry[]; totalAttempts: number } | undefined;
  loading: boolean;
}) {
  if (loading && !history) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-9 w-full rounded-lg" />
        <Skeleton className="h-9 w-full rounded-lg" />
      </div>
    );
  }
  const spawns = history?.spawns ?? [];
  if (spawns.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-muted/10 px-3 py-4 text-center text-xs text-muted-foreground">
        该节点尚未产生任何 attempt。
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {spawns.map((s) => (
        <AttemptRow key={s.spawnId} spawn={s} />
      ))}
    </div>
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
  extra,
  body,
  empty,
  loading,
}: {
  icon: typeof IconFileText;
  title: string;
  meta?: string;
  /** Extra element rendered in the header row (e.g. the evidence badge). */
  extra?: React.ReactNode;
  body: string | null | undefined;
  empty: string;
  loading?: boolean;
}) {
  return (
    <section className="flex min-h-0 flex-col">
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <Icon className="size-3.5 text-muted-foreground" />
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h4>
        {extra}
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

// ── Node action buttons (retry / skip / edit-and-retry / human_gate) ────────

interface WorkflowPatchResult {
  ok: boolean;
  error?: string;
  new_dag_version?: number;
}

function NodeActionsBar({
  runId,
  node,
  dagNode,
  dagVersion,
}: {
  runId: string;
  node: V3Node;
  dagNode: V3DagNode | undefined;
  dagVersion: number | undefined;
}) {
  const retryMutation = useActionMutation("nodeRetry" as any, {});
  const skipMutation = useActionMutation("nodeSkip" as any, {});
  const patchMutation = useActionMutation("workflowPatch" as any, {});
  const gateMutation = useActionMutation("nodeResolveGate" as any, {});

  const [editOpen, setEditOpen] = useState(false);
  const [promptDraft, setPromptDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");

  const status = node.status;
  const isAgentNode = dagNode?.type === "agent";
  const isHumanGate = dagNode?.type === "human_gate";
  const retryDisabled = status !== "failed" || retryMutation.isPending;
  const skipDisabled =
    status === "done" || status === "skipped" || skipMutation.isPending;

  function handleRetry() {
    retryMutation.mutate(
      { runId, nodeId: node.id },
      {
        onSuccess: () => toast.success("已重试节点，等待重新调度"),
        onError: (err: unknown) =>
          toast.error(err instanceof Error ? err.message : "重试失败"),
      },
    );
  }

  function handleSkip() {
    skipMutation.mutate(
      { runId, nodeId: node.id },
      {
        onSuccess: () => toast.success("已跳过节点"),
        onError: (err: unknown) =>
          toast.error(err instanceof Error ? err.message : "跳过失败"),
      },
    );
  }

  function openEdit() {
    setPromptDraft("");
    setModelDraft("");
    setEditOpen(true);
  }

  async function submitEdit() {
    if (!dagNode || dagVersion == null) return;
    const set: Record<string, string> = {};
    if (promptDraft.trim()) set.prompt = promptDraft.trim();
    if (modelDraft.trim()) set.model_override = modelDraft.trim();
    if (Object.keys(set).length === 0) {
      toast.error("请填写新的提示词或模型后再提交");
      return;
    }
    try {
      // A failed node is IMMUTABLE to workflowPatch until it's reset — retry
      // first (resets to "ready"), then patch (server/engine/v3-patcher.ts
      // demotes "ready" to "pending" and applies the edit there).
      if (status === "failed") {
        await retryMutation.mutateAsync({ runId, nodeId: node.id });
      }
      const result = (await patchMutation.mutateAsync({
        runId,
        expected_dag_version: dagVersion,
        ops: [{ op: "modify_node", node_id: dagNode.id, set }],
        reason: "编辑后重试",
      })) as WorkflowPatchResult;
      if (result && result.ok === false) {
        toast.error(
          result.error === "node_not_patchable"
            ? "该节点正在运行或已完成，无法编辑——如需更改已执行/运行中的节点，请使用 Fork 分叉新运行。"
            : (result.error ?? "补丁提交失败"),
        );
        return;
      }
      toast.success("已提交补丁，节点将按新内容重新执行");
      setEditOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "提交失败");
    }
  }

  function resolveGate(choice: string) {
    gateMutation.mutate(
      { runId, nodeId: node.id, choice },
      {
        onSuccess: () =>
          toast.success(
            `节点已${choice === "approve" ? "批准" : choice === "reject" ? "驳回" : `处理为 ${choice}`}`,
          ),
        onError: (err: unknown) =>
          toast.error(err instanceof Error ? err.message : "操作失败"),
      },
    );
  }

  const declaredOptions = (dagNode as { options?: unknown } | undefined)
    ?.options;
  const gateOptions =
    Array.isArray(declaredOptions) && declaredOptions.length > 0
      ? (declaredOptions as string[])
      : ["approve", "reject"];

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
      {isHumanGate && status === "awaiting-approval" ? (
        gateOptions.map((opt) => (
          <Button
            key={opt}
            size="sm"
            variant={
              opt === "approve"
                ? "default"
                : opt === "reject"
                  ? "destructive"
                  : "outline"
            }
            disabled={gateMutation.isPending}
            onClick={() => resolveGate(opt)}
          >
            {opt === "approve" ? "批准" : opt === "reject" ? "驳回" : opt}
          </Button>
        ))
      ) : (
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={retryDisabled}
            onClick={handleRetry}
          >
            <IconRotate className="mr-1 size-3.5" />
            重试
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={skipDisabled}
            onClick={handleSkip}
          >
            <IconPlayerSkipForward className="mr-1 size-3.5" />
            跳过
          </Button>
          {isAgentNode ? (
            <Button size="sm" variant="outline" onClick={openEdit}>
              <IconEdit className="mr-1 size-3.5" />
              编辑后重试
            </Button>
          ) : null}
        </>
      )}
      <span className="ml-auto max-w-[220px] text-right text-[10.5px] text-muted-foreground">
        运行中/已完成节点不可重试或跳过；如需更改，请用 Fork 分叉新运行
      </span>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑后重试 — {dagNode?.id}</DialogTitle>
            <DialogDescription>
              修改提示词或模型后提交为 DAG
              补丁（workflowPatch）。失败节点会先自动重试为可编辑状态；运行中/已完成节点无法编辑，请改用
              Fork。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="edit-retry-prompt">新提示词（留空则不改）</Label>
              <Textarea
                id="edit-retry-prompt"
                rows={6}
                className="font-mono text-xs"
                value={promptDraft}
                onChange={(e) => setPromptDraft(e.target.value)}
                placeholder="留空则沿用当前提示词模板"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-retry-model">模型覆盖（留空则不改）</Label>
              <Input
                id="edit-retry-model"
                className="font-mono text-xs"
                value={modelDraft}
                onChange={(e) => setModelDraft(e.target.value)}
                placeholder="例如 qwen3.6 / claude-sonnet-4-5"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              取消
            </Button>
            <Button
              onClick={submitEdit}
              disabled={patchMutation.isPending || retryMutation.isPending}
            >
              {patchMutation.isPending || retryMutation.isPending
                ? "提交中…"
                : "提交补丁"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
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
  /** Full DAG node definition (type/options/retry/etc.) for action gating. */
  dagNode?: V3DagNode;
  /** Current DAG version — required for workflowPatch's optimistic-concurrency check. */
  dagVersion?: number;
  /** Run-level tags, used to ground the payload-allowlist evidence badge in real data. */
  runTags?: unknown;
  hasSelection: boolean;
}

export function NodeInspector({
  runId,
  node,
  dagNodeId,
  dagAgent,
  dagNode,
  dagVersion,
  runTags,
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
  const { data: attemptHistory, isLoading: attemptLoading } =
    useV3NodeSpawnHistory(runId, node?.id);

  const agentLabel = useMemo(
    () => agentPresentation(summary?.spawn?.agentName ?? dagAgent),
    [summary?.spawn?.agentName, dagAgent],
  );

  // Real, non-fabricated grounding for the "载荷白名单" evidence badge (red
  // line C2, docs/sdlc-product-design/02-workflows.md §"载荷契约表"): the
  // dispatch protocol only ever injects brief + shared-brief + ui-spec
  // summaries into a worker's rendered prompt — never sprint-doc/
  // technical-design full text. The category list is the documented, fixed
  // policy; only the item id varies per run, read from the run's real tags.
  const evidenceItemId = useMemo(() => {
    if (runTags && typeof runTags === "object") {
      const v =
        (runTags as Record<string, unknown>).item_id ??
        (runTags as Record<string, unknown>).itemId;
      if (typeof v === "string" && v) return v;
    }
    return null;
  }, [runTags]);

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
            <Badge
              variant="secondary"
              className="h-5 px-1.5 font-mono text-[11px]"
            >
              {summary.type}
            </Badge>
          ) : null}
          {summary && (summary.iteration > 0 || summary.fanoutIndex > 0) ? (
            <span className="font-mono text-[11px] text-muted-foreground">
              {summary.iteration > 0 ? `iter ${summary.iteration}` : ""}
              {summary.fanoutIndex > 0 ? ` · #${summary.fanoutIndex}` : ""}
            </span>
          ) : null}
          {attemptHistory && attemptHistory.totalAttempts > 0 ? (
            <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <IconHistory className="size-3" />
              attempt {attemptHistory.totalAttempts}
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
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
            <dt className="shrink-0 text-muted-foreground">开始时间</dt>
            <dd className="truncate text-right font-mono text-foreground/80">
              {fmtDateTime(node?.startedAt)}
            </dd>
            <dt className="shrink-0 text-muted-foreground">完成时间</dt>
            <dd className="truncate text-right font-mono text-foreground/80">
              {fmtDateTime(node?.completedAt)}
            </dd>
          </dl>

          {/* Error */}
          {node?.error || summary?.error ? (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-xs text-red-600 dark:text-red-400">
              <IconAlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span className="break-words">
                {node?.error ?? summary?.error}
              </span>
            </div>
          ) : null}

          <Separator />

          {/* Attempt timeline */}
          <section className="flex min-h-0 flex-col">
            <div className="mb-1.5 flex items-center gap-1.5">
              <IconHistory className="size-3.5 text-muted-foreground" />
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Attempt 时间线
              </h4>
            </div>
            <AttemptTimeline
              history={attemptHistory}
              loading={attemptLoading}
            />
          </section>

          {/* Rendered prompt */}
          <TextBlock
            icon={IconMessageCircle}
            title="渲染后的提示词"
            body={spawnDetail?.renderedPrompt}
            loading={spawnLoading && !spawnDetail}
            empty="该节点没有记录提示词。"
            extra={
              spawnDetail?.renderedPrompt ? (
                <Badge className="h-4.5 gap-1 border-evidence/30 bg-evidence/10 px-1.5 text-[10px] text-evidence hover:bg-evidence/10">
                  <IconShieldLock className="size-2.5" />
                  载荷白名单：
                  {evidenceItemId ? `brief:${evidenceItemId}` : "brief"} +
                  shared-brief
                </Badge>
              ) : undefined
            }
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

          {node ? (
            <NodeActionsBar
              runId={runId}
              node={node}
              dagNode={dagNode}
              dagVersion={dagVersion}
            />
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}
