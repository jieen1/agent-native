import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type {
  GraphValidationIssue,
  Sprint,
  StageName,
  TrackerWorkItem,
} from "@shared/types";
import { STAGE_ORDER } from "@shared/types";
import {
  IconAffiliate,
  IconAlertTriangle,
  IconArrowBackUp,
  IconArrowUp,
  IconCircleCheck,
  IconColumns,
  IconExternalLink,
  IconHandStop,
  IconLayoutKanban,
  IconLayoutRows,
  IconList,
  IconPlus,
  IconRefresh,
  IconSearch,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";

import { ActorAvatar } from "@/components/ActorAvatar";
import { PriorityBars } from "@/components/PriorityBars";
import { RunBadgeCompact } from "@/components/RunEvidenceList";
import { StatusIcon } from "@/components/StatusIcon";
import { StatusRing } from "@/components/StatusRing";
import { orchestratorRunHref, typeChip } from "@/components/tracker-format";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useWorkItems,
  useSprints,
  useValidateDependencyGraph,
  useAdvanceStage,
  useRollbackStage,
  useDispatch,
  useRequestApproval,
  useActivity,
  useOrgMembers,
} from "@/hooks/use-tracker";
import {
  classifyBoardDrop,
  firstFailureSummary,
  isColumnSlim,
  miniStepDots,
  miniStepSequence,
  resolveCardActor,
  runningQueuedCounts,
  STAGE_RING_STATUS,
} from "@/lib/board";
import { previousStage } from "@/lib/inbox";
import { cn } from "@/lib/utils";

// ── Priority helpers ─────────────────────────────────────────────────────────

const PRIORITY_LABELS: Record<number, string> = {
  1: "P0",
  2: "P1",
  3: "P2",
  4: "P3",
};

// ── Risk helpers (filter dropdown only — the s1 prototype does not render a
// risk chip on the card itself, see docs/sdlc-product-design/prototypes/
// s1-tracker-board.html's .bcard markup) ─────────────────────────────────────

const RISK_LABELS: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
};

// ── mini-step (issue #8: StageStepper 微缩) ──────────────────────────────────

export function MiniStageStepper({
  sequence,
  currentStageName,
  status,
}: {
  sequence: StageName[];
  currentStageName: string;
  status: string;
}) {
  const dots = miniStepDots(sequence, currentStageName, status);
  return (
    <span
      className="inline-flex shrink-0 items-center gap-[3px]"
      title={`阶段: ${sequence.join(" → ")}`}
    >
      {dots.map((d, i) => (
        <span
          key={i}
          className={cn(
            "block size-1.5 rounded-full",
            d === "done" && "bg-success",
            d === "active" && "bg-info animate-pulse",
            d === "failed" && "bg-destructive",
            d === "future" && "bg-border",
          )}
        />
      ))}
    </span>
  );
}

// ── Run signal (issue #7: breathe spinner + elapsed + RunBadge deep link;
// awaiting-gate hand-stop badge for status=blocked) ──────────────────────────

function RunSignalLine({ item }: { item: TrackerWorkItem }) {
  const isRunning = item.status === "running" || item.status === "dispatched";
  const isQueued = item.status === "queued";
  const isBlocked = item.status === "blocked";

  if (isBlocked) {
    return (
      <div className="flex items-center gap-1.5 rounded-md bg-warning/10 px-2 py-1 text-[11px] text-warning">
        <StatusRing status="gate" size={11} />
        等待人工确认
      </div>
    );
  }

  if (!isRunning && !isQueued) return null;

  return (
    <div className="flex items-center gap-1.5 rounded-md bg-info/10 px-2 py-1 text-[11px]">
      <StatusRing status={isRunning ? "running" : "queued"} size={11} />
      <span className="text-foreground/80">
        {isRunning ? "执行中" : "排队中"}
        {item.dispatchedAt ? ` · ${relativeElapsed(item.dispatchedAt)}` : ""}
      </span>
      {item.orchestratorRunId ? (
        <RunBadgeCompact
          run={{
            runId: item.orchestratorRunId,
            threadId: item.orchestratorThreadId,
            branch: item.branch ?? null,
            dispatchedAt: item.dispatchedAt ?? item.updatedAt,
            superseded: false,
          }}
          activity={undefined}
        />
      ) : null}
    </div>
  );
}

function relativeElapsed(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

// ── Failed card: single truncated error line (issue #9) ─────────────────────
// A per-card useActivity poll, scoped to failed cards only (usually a small
// subset of the board) — same 4s cadence RunEvidenceList/InboxPage already
// use for open-item failure evidence, reusing the real `failingNodesOf`
// predicate rather than fabricating an error string from item.description.
function FailedCardErrorLine({ workItemId }: { workItemId: string }) {
  const { data: activity } = useActivity(workItemId, true);
  const summary = firstFailureSummary(activity);
  if (!summary) return null;
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-destructive">
      <IconAlertTriangle className="size-3.5 shrink-0" />
      <span className="truncate">{summary}</span>
    </div>
  );
}

// ── Failed card hover actions: 重派 / 回退 / 升级 ─────────────────────────────

function FailedCardHoverActions({ item }: { item: TrackerWorkItem }) {
  const dispatch = useDispatch();
  const rollbackStage = useRollbackStage();
  const requestApproval = useRequestApproval();
  const prevStage = previousStage(item.currentStageName);

  return (
    <span
      className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100"
      // Stop the card's own <Link> navigation from firing for these buttons.
      onClick={(e) => e.preventDefault()}
    >
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded border border-border bg-card px-1.5 py-0.5 text-[10px] hover:bg-muted"
        disabled={dispatch.isPending}
        onClick={() =>
          dispatch.mutate(
            { workItemId: item.id },
            { onSuccess: () => toast.success("已重新派发") },
          )
        }
      >
        <IconRefresh className="size-3" />
        重派
      </button>
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded border border-border bg-card px-1.5 py-0.5 text-[10px] hover:bg-muted disabled:opacity-40"
        disabled={rollbackStage.isPending || !prevStage}
        onClick={() =>
          prevStage &&
          rollbackStage.mutate(
            { workItemId: item.id, targetStage: prevStage },
            { onSuccess: () => toast.success(`已回退至「${prevStage}」`) },
          )
        }
      >
        <IconArrowBackUp className="size-3" />
        回退
      </button>
      {item.sprintId ? (
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded border border-border bg-card px-1.5 py-0.5 text-[10px] hover:bg-muted"
          disabled={requestApproval.isPending}
          onClick={() =>
            item.sprintId &&
            requestApproval.mutate(
              {
                sprintId: item.sprintId,
                gateKey: "escalation",
                workItemId: item.id,
              },
              { onSuccess: () => toast.success("已升级至裁决") },
            )
          }
        >
          <IconArrowUp className="size-3" />
          升级
        </button>
      ) : null}
    </span>
  );
}

// ── Work item card (pure presentational — no drag wiring here) ──────────────

export function WorkItemCard({ item }: { item: TrackerWorkItem }) {
  const isFailed = item.status === "failed";
  const sequence = miniStepSequence(item.plannedStages);
  const isSubset = sequence.length < 7 && sequence.length > 0;
  const actor = resolveCardActor(item.owner);
  const actorLive = item.status === "running" || item.status === "dispatched";

  return (
    <div
      className={cn(
        "group flex flex-col gap-1.5 rounded-lg border bg-card p-3 shadow-sm transition-all hover:border-foreground/20 hover:shadow",
        isFailed
          ? "border-destructive/30 bg-destructive/5"
          : actorLive
            ? "border-info/40"
            : "border-border",
      )}
      data-testid={`work-item-${item.id}`}
      data-status={item.status}
    >
      {/* row1: type badge + key(mono) + PriorityBars (right-aligned) */}
      <div className="flex items-center gap-1.5">
        <Badge
          variant="outline"
          className={cn("h-4 px-1 text-[10px] capitalize", typeChip(item.type))}
        >
          {item.type}
        </Badge>
        <span
          className="font-mono text-[10px] font-medium text-muted-foreground"
          title={
            item.itemKeyDisplay && item.itemKeyDisplay !== item.itemKey
              ? "历史重号，已消歧显示"
              : undefined
          }
        >
          {item.itemKeyDisplay ?? item.itemKey}
        </span>
        <PriorityBars priority={item.priority} className="ml-auto" />
      </div>

      {/* Title */}
      <p className="line-clamp-2 text-sm font-bold leading-snug text-foreground">
        {item.title}
      </p>

      {/* Tags */}
      {item.tags && item.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {item.tags.map((tag) => (
            <span
              key={tag}
              className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      ) : null}

      {/* Run signal / failure evidence */}
      {isFailed ? (
        <FailedCardErrorLine workItemId={item.id} />
      ) : (
        <RunSignalLine item={item} />
      )}

      {/* Foot: mini-step + (subset caption) + hover actions + ActorAvatar */}
      <div className="flex items-center gap-1.5 border-t border-border/60 pt-1.5">
        <MiniStageStepper
          sequence={sequence}
          currentStageName={item.currentStageName}
          status={item.status}
        />
        {isSubset ? (
          <span className="text-[10px] text-muted-foreground">
            阶段子集：{sequence[0]}
            {sequence.length > 1 ? ` → ${sequence[sequence.length - 1]}` : ""}
          </span>
        ) : null}
        {isFailed ? <FailedCardHoverActions item={item} /> : null}
        <ActorAvatar
          kind={actor.kind}
          initials={actor.initials}
          live={actorLive}
          size={20}
          className="ml-auto"
        />
      </div>
    </div>
  );
}

// ── Draggable card wrapper (issue #4) ────────────────────────────────────────

function BoardCard({ item }: { item: TrackerWorkItem }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: item.id,
    data: { item },
  });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={isDragging ? "opacity-40" : undefined}
    >
      <Link to={`/items/${item.id}`} className="block">
        <WorkItemCard item={item} />
      </Link>
    </div>
  );
}

// ── Board column (droppable, issue #1 slim/full + issue #2 StatusRing head +
// issue #3 实施 aggregation) ──────────────────────────────────────────────────

function BoardColumnHeader({
  stage,
  count,
}: {
  stage: StageName;
  count: number;
  items: TrackerWorkItem[];
}) {
  const ringStatus = STAGE_RING_STATUS[stage];
  return (
    <div className="flex shrink-0 items-center gap-1.5 px-1 py-0.5">
      {stage === "交付" ? (
        <StatusIcon tone="ok" size="sm" />
      ) : ringStatus ? (
        <StatusRing status={ringStatus} />
      ) : null}
      <h3 className="text-[12.5px] font-semibold">{stage}</h3>
      <span className="font-mono text-[11px] text-muted-foreground">
        {count}
      </span>
    </div>
  );
}

interface DropCue {
  kind: "advance" | "rollback" | "forbidden";
  label: string;
}

function dropCueFor(
  draggingFromStage: StageName | null,
  stage: StageName,
): DropCue | null {
  if (!draggingFromStage) return null;
  const classification = classifyBoardDrop(draggingFromStage, stage);
  switch (classification.kind) {
    case "sprint-advance":
      return {
        kind: "advance",
        label: "松手 = 请求 Sprint 相位推进（作用于整个 Sprint）",
      };
    case "rollback":
      return { kind: "rollback", label: `松手 = 回退至「${stage}」` };
    case "locked-active":
      return { kind: "forbidden", label: "实施⇄测试 不支持手动拖拽" };
    case "skip-forbidden":
      return { kind: "forbidden", label: "每次只能移动一步" };
    default:
      return null;
  }
}

function BoardColumn({
  stage,
  items,
  isLoading,
  draggingFromStage,
}: {
  stage: StageName;
  items: TrackerWorkItem[];
  isLoading: boolean;
  draggingFromStage: StageName | null;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  const slim = isColumnSlim(stage, items.length);
  const cue = dropCueFor(draggingFromStage, stage);
  const showCue = isOver && !!cue && draggingFromStage !== stage;
  const { running, queued } = runningQueuedCounts(items);

  let emptyText = "本相位无卡片";
  if (stage === "待办") emptyText = "拖入卡片，或按 C 新建";

  return (
    <div
      className={cn(
        "flex shrink-0 flex-col gap-2 rounded-xl bg-muted/20 p-2",
        slim ? "w-[150px]" : "w-[280px]",
      )}
    >
      <div className="flex items-center gap-1.5">
        <BoardColumnHeader stage={stage} count={items.length} items={items} />
        {stage === "实施" && (running > 0 || queued > 0) ? (
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
            运行中 {running} · 排队 {queued}
          </span>
        ) : null}
      </div>

      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-[80px] flex-1 flex-col gap-2 overflow-y-auto rounded-lg",
          showCue &&
            cue!.kind !== "forbidden" &&
            "ring-2 ring-brand ring-offset-1",
          showCue && cue!.kind === "forbidden" && "ring-2 ring-destructive/60",
        )}
      >
        {showCue ? (
          <div
            className={cn(
              "flex h-[52px] shrink-0 items-center justify-center gap-1.5 rounded-lg border-1.5 border-dashed px-2 text-center text-[11px]",
              cue!.kind === "forbidden"
                ? "border-destructive/60 bg-destructive/5 text-destructive"
                : "border-brand bg-brand/5 text-brand",
            )}
          >
            <IconHandStop className="size-3.5 shrink-0" />
            {cue!.label}
          </div>
        ) : null}

        {isLoading ? (
          Array.from({ length: 2 }).map((_, i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-lg bg-muted/40"
            />
          ))
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-[11.5px] text-muted-foreground/70">
            {emptyText}
          </p>
        ) : (
          items.map((it) => <BoardCard key={it.id} item={it} />)
        )}
      </div>
    </div>
  );
}

// ── Dependency-graph validation dialog (M1-5, unchanged — 图校验 belongs to
// the Epic decomposition view per 03-tracker.md §7, not the board's own spec;
// kept in place rather than removed since another surface may depend on this
// entry point) ────────────────────────────────────────────────────────────

const ISSUE_LABELS: Record<GraphValidationIssue["code"], string> = {
  "self-dependency": "自依赖",
  cycle: "依赖环",
  "chain-too-deep": "链过深",
  "no-parallelism": "无并行度",
  orphan: "孤儿节点",
};

function IssueRow({
  issue,
  tone,
}: {
  issue: GraphValidationIssue;
  tone: "error" | "warning";
}) {
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 text-xs leading-relaxed",
        tone === "error"
          ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400"
          : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
      )}
    >
      <span className="mr-1.5 font-semibold">
        [{ISSUE_LABELS[issue.code] ?? issue.code}]
      </span>
      {issue.message}
    </div>
  );
}

function GraphValidationDialog({
  open,
  onOpenChange,
  scope,
  scopeId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: "epic" | "sprint" | undefined;
  scopeId: string | undefined;
}) {
  const { data, isLoading } = useValidateDependencyGraph(scope, scopeId, open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>图校验结果</DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-[60vh] pr-3">
          {isLoading ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              校验中…
            </p>
          ) : !data ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              暂无数据
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {data.errors.length === 0 && data.warnings.length === 0 ? (
                <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
                  <IconCircleCheck className="size-4 shrink-0" />
                  未发现问题
                </div>
              ) : null}

              {data.errors.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  <h4 className="text-xs font-semibold text-muted-foreground">
                    错误 ({data.errors.length})
                  </h4>
                  {data.errors.map((issue, i) => (
                    <IssueRow key={`err-${i}`} issue={issue} tone="error" />
                  ))}
                </div>
              ) : null}

              {data.warnings.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  <h4 className="text-xs font-semibold text-muted-foreground">
                    警告 ({data.warnings.length})
                  </h4>
                  {data.warnings.map((issue, i) => (
                    <IssueRow key={`warn-${i}`} issue={issue} tone="warning" />
                  ))}
                </div>
              ) : null}

              <div className="flex flex-col gap-1.5">
                <h4 className="text-xs font-semibold text-muted-foreground">
                  拓扑排序
                  {data.topoOrder.length === 0 ? "(存在环,无法排序)" : ""}
                </h4>
                {data.topoOrder.length > 0 ? (
                  <ol className="flex flex-col gap-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
                    {data.topoOrder.map((key, i) => (
                      <li key={key} className="flex items-center gap-2">
                        <span className="font-mono text-muted-foreground">
                          {i + 1}.
                        </span>
                        {key}
                      </li>
                    ))}
                  </ol>
                ) : null}
              </div>
            </div>
          )}
        </ScrollArea>

        <DialogFooter>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Active-run rollback guard (issue #4: "绑定活跃 run 时先弹 runCancel 确认")
// rollback-stage itself rejects a rollback while a run is bound and
// running/dispatched — this surfaces that constraint BEFORE attempting the
// mutation, with a deep link to the run so the user can cancel it there.
// Tracker has no cross-app run-cancel action of its own to call directly. ───

function ActiveRunRollbackDialog({
  item,
  toStage,
  onClose,
}: {
  item: TrackerWorkItem | null;
  toStage: StageName | null;
  onClose: () => void;
}) {
  return (
    <AlertDialog open={!!item} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>该工作项绑定的运行正在执行中</AlertDialogTitle>
          <AlertDialogDescription>
            回退到「{toStage}」前需要先取消绑定的运行——看板暂不提供跨应用的
            取消运行操作，请打开运行详情页取消，再回到看板重试回退。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {item?.orchestratorRunId ? (
            <Button asChild variant="outline" size="sm">
              <a
                href={orchestratorRunHref(item.orchestratorRunId)}
                className="gap-1.5"
              >
                <IconExternalLink className="size-3.5" />
                查看运行详情
              </a>
            </Button>
          ) : null}
          <AlertDialogAction onClick={onClose}>知道了</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Board page ───────────────────────────────────────────────────────────────

export function BoardPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const projectId = params.get("project") ?? undefined;

  const { data: itemsRaw, isLoading } = useWorkItems(projectId);
  const items = (itemsRaw ?? []) as TrackerWorkItem[];

  const { data: sprintsRaw } = useSprints();
  const sprints = (sprintsRaw ?? []) as Sprint[];
  const { data: membersData } = useOrgMembers();
  const members = membersData?.members ?? [];

  const currentSprint = sprints.find((s) => s.status === "进行中");

  // Filter state
  const [selectedSprintId, setSelectedSprintId] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [riskFilter, setRiskFilter] = useState("all");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [hiddenStages, setHiddenStages] = useState<Set<StageName>>(new Set());

  // 图校验 dialog (M1-5) — out of the s1 board spec (belongs to the Epic
  // decomposition view, 03-tracker.md §7), left as-is rather than removed.
  const [graphDialogOpen, setGraphDialogOpen] = useState(false);
  const graphScope: "epic" | "sprint" | undefined =
    selectedSprintId !== "all" ? "sprint" : projectId ? "epic" : undefined;
  const graphScopeId =
    selectedSprintId !== "all" ? selectedSprintId : projectId;

  const advanceStage = useAdvanceStage();
  const rollbackStage = useRollbackStage();
  const [activeRunRollback, setActiveRunRollback] = useState<{
    item: TrackerWorkItem;
    toStage: StageName;
  } | null>(null);

  // "C" — global new-work-item shortcut (01-design-system.md §4.1
  // CommandPalette). Ignored while typing in an input/textarea/contentEditable.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== "c" || e.metaKey || e.ctrlKey || e.altKey)
        return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable)
        return;
      navigate("/items/new");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  const uniqueTypes = useMemo(() => {
    const set = new Set(items.map((it) => it.type));
    return Array.from(set).sort();
  }, [items]);

  const uniquePriorities = useMemo(() => {
    const set = new Set(items.map((it) => it.priority));
    return Array.from(set).sort((a, b) => a - b);
  }, [items]);

  const filteredItems = useMemo(() => {
    return items.filter((it) => {
      if (selectedSprintId !== "all" && it.sprintId !== selectedSprintId)
        return false;
      if (typeFilter !== "all" && it.type !== typeFilter) return false;
      if (priorityFilter !== "all" && it.priority !== Number(priorityFilter))
        return false;
      if (riskFilter !== "all" && it.risk !== riskFilter) return false;
      if (ownerFilter !== "all") {
        if (
          ownerFilter === "unassigned" ? !!it.owner : it.owner !== ownerFilter
        )
          return false;
      }
      if (search) {
        const q = search.toLowerCase();
        if (
          !it.title.toLowerCase().includes(q) &&
          !(it.itemKey ?? "").toLowerCase().includes(q) &&
          !(it.description ?? "").toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [
    items,
    selectedSprintId,
    typeFilter,
    priorityFilter,
    riskFilter,
    ownerFilter,
    search,
  ]);

  const grouped = useMemo(() => {
    const map: Record<string, TrackerWorkItem[]> = {};
    for (const stage of STAGE_ORDER) map[stage] = [];
    for (const it of filteredItems) {
      const stage = it.currentStageName as StageName;
      if ((STAGE_ORDER as string[]).includes(stage)) map[stage].push(it);
      else map["待办"].push(it);
    }
    return map;
  }, [filteredItems]);

  const visibleStages = STAGE_ORDER.filter((s) => !hiddenStages.has(s));

  // ── Drag state ──────────────────────────────────────────────────────────
  const [activeDragItem, setActiveDragItem] = useState<TrackerWorkItem | null>(
    null,
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  function handleDragStart(event: DragStartEvent) {
    const item = event.active.data.current?.item as TrackerWorkItem | undefined;
    setActiveDragItem(item ?? null);
  }

  function handleDragCancel() {
    setActiveDragItem(null);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    const item = active.data.current?.item as TrackerWorkItem | undefined;
    setActiveDragItem(null);
    if (!item || !over) return;

    const fromStage = item.currentStageName as StageName;
    const toStage = String(over.id) as StageName;
    const classification = classifyBoardDrop(fromStage, toStage);

    switch (classification.kind) {
      case "noop":
        return;

      case "locked-active":
        toast.error("实施⇄测试 之间不支持手动拖拽", {
          description:
            "该转移只能通过运行回写，或工作项详情里的「人工完成」发生。",
        });
        return;

      case "skip-forbidden": {
        const fromIdx = STAGE_ORDER.indexOf(fromStage);
        const toIdx = STAGE_ORDER.indexOf(toStage);
        const nextStage = STAGE_ORDER[fromIdx + (toIdx > fromIdx ? 1 : -1)];
        toast.error("阶段每次只能移动一步", {
          description: `请将卡片拖拽到「${nextStage}」列。`,
        });
        return;
      }

      case "rollback": {
        const hasActiveRun =
          (item.status === "running" || item.status === "dispatched") &&
          !!item.orchestratorRunId;
        if (hasActiveRun) {
          setActiveRunRollback({ item, toStage: classification.toStage });
          return;
        }
        rollbackStage.mutate(
          { workItemId: item.id, targetStage: classification.toStage },
          {
            onSuccess: () =>
              toast.success(`已回退至「${classification.toStage}」`),
          },
        );
        return;
      }

      case "sprint-advance": {
        if (!item.sprintId) {
          toast.error("无法请求相位推进", {
            description: "该工作项未绑定 Sprint。",
          });
          return;
        }
        const sprintName =
          sprints.find((s) => s.id === item.sprintId)?.name ?? "该 Sprint";
        const nextStage =
          STAGE_ORDER[STAGE_ORDER.indexOf(classification.fromStage) + 1];
        advanceStage.mutate(
          { scope: "sprint", id: item.sprintId, fromStage: fromStage },
          {
            onSuccess: (data: unknown) => {
              const cascaded =
                (data as { cascaded?: { ok: boolean; error?: string }[] })
                  ?.cascaded ?? [];
              const okCount = cascaded.filter((c) => c.ok).length;
              const guarded = cascaded.filter((c) =>
                c.error?.includes("delivery-guarded"),
              );
              const blocked = cascaded.filter((c) =>
                c.error?.startsWith("blocked:"),
              );

              if (cascaded.length === 0) {
                toast.info(
                  `「${sprintName}」中没有处于「${fromStage}」的工作项`,
                );
                return;
              }
              if (guarded.length > 0 && okCount === 0 && blocked.length === 0) {
                toast.error("交付需要人工完成", {
                  description:
                    "推进到「交付」不支持看板拖拽——请在工作项详情页使用「人工完成」（需要 PR/提交等证据）。",
                });
                return;
              }
              if (blocked.length > 0) {
                const missing = blocked
                  .map((c) => c.error?.replace(/^blocked:\s*/, ""))
                  .filter(Boolean)
                  .join("；");
                toast.error(`推进到「${nextStage}」= 请求 Sprint 相位推进`, {
                  description: `单卡在相位派生阶段没有独立前进语义——此操作作用于整个「${sprintName}」。${okCount > 0 ? `已推进 ${okCount} 项。` : ""}判据未满足：${missing}`,
                });
                return;
              }
              toast.success(
                `已推进「${sprintName}」中 ${okCount} 项工作项至「${nextStage}」`,
              );
            },
          },
        );
      }
    }
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* ── Header ── */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-6 py-3">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold tracking-tight">看板</h1>
          <span className="text-sm text-muted-foreground">
            {currentSprint ? currentSprint.name : "全部 Sprint"}
          </span>
          <span className="font-mono text-xs text-muted-foreground">
            {filteredItems.length} 项
          </span>
        </div>
        <Button asChild size="sm" className="gap-1.5">
          <Link to="/items/new">
            <IconPlus className="size-4" />
            新建工作项
            <kbd className="ml-0.5 rounded border border-primary-foreground/25 bg-primary-foreground/15 px-1 font-mono text-[10px] text-primary-foreground/85">
              C
            </kbd>
          </Link>
        </Button>
      </header>

      {/* ── Toolbar ── */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-6 py-2">
        <Tabs value="board">
          <TabsList className="h-8">
            <TabsTrigger value="board" className="h-7 gap-1.5 text-xs">
              <IconLayoutKanban className="size-3.5" />
              看板
            </TabsTrigger>
            <TabsTrigger
              value="list"
              disabled
              title="列表视图即将推出"
              className="h-7 gap-1.5 text-xs"
            >
              <IconList className="size-3.5" />
              列表
            </TabsTrigger>
            <TabsTrigger
              value="swimlane"
              disabled
              title="泳道视图即将推出"
              className="h-7 gap-1.5 text-xs"
            >
              <IconLayoutRows className="size-3.5" />
              泳道
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <Select value={selectedSprintId} onValueChange={setSelectedSprintId}>
          <SelectTrigger className="h-8 w-[160px] text-xs">
            <SelectValue placeholder="全部 Sprint" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部 Sprint</SelectItem>
            {sprints.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="h-8 w-[130px] text-xs">
            <SelectValue placeholder="全部类型" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部类型</SelectItem>
            {uniqueTypes.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={priorityFilter} onValueChange={setPriorityFilter}>
          <SelectTrigger className="h-8 w-[130px] text-xs">
            <SelectValue placeholder="全部优先级" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部优先级</SelectItem>
            {uniquePriorities.map((p) => (
              <SelectItem key={p} value={String(p)}>
                {PRIORITY_LABELS[p] ?? `P${p}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={riskFilter} onValueChange={setRiskFilter}>
          <SelectTrigger className="h-8 w-[130px] text-xs">
            <SelectValue placeholder="全部风险" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部风险</SelectItem>
            <SelectItem value="low">{RISK_LABELS.low}</SelectItem>
            <SelectItem value="medium">{RISK_LABELS.medium}</SelectItem>
            <SelectItem value="high">{RISK_LABELS.high}</SelectItem>
          </SelectContent>
        </Select>

        <Select value={ownerFilter} onValueChange={setOwnerFilter}>
          <SelectTrigger className="h-8 w-[130px] text-xs">
            <SelectValue placeholder="全部负责人" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部负责人</SelectItem>
            <SelectItem value="agent">智能体</SelectItem>
            <SelectItem value="unassigned">未分配</SelectItem>
            {members.map((m) => (
              <SelectItem key={m.email} value={m.email}>
                {m.email}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs">
              <IconColumns className="size-3.5" />
              列显隐
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>显示的列</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {STAGE_ORDER.map((stage) => (
              <DropdownMenuCheckboxItem
                key={stage}
                checked={!hiddenStages.has(stage)}
                onCheckedChange={(checked) => {
                  setHiddenStages((prev) => {
                    const next = new Set(prev);
                    if (checked) next.delete(stage);
                    else next.add(stage);
                    return next;
                  });
                }}
              >
                {stage}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1.5 text-xs"
          disabled={!graphScopeId}
          onClick={() => setGraphDialogOpen(true)}
        >
          <IconAffiliate className="size-3.5" />
          图校验
        </Button>

        <div className="ml-auto flex items-center gap-1.5">
          <IconSearch className="size-3.5 text-muted-foreground" />
          <Input
            placeholder="搜索标题/编号…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-[200px] text-xs"
          />
        </div>
      </div>

      <GraphValidationDialog
        open={graphDialogOpen}
        onOpenChange={setGraphDialogOpen}
        scope={graphScope}
        scopeId={graphScopeId}
      />
      <ActiveRunRollbackDialog
        item={activeRunRollback?.item ?? null}
        toStage={activeRunRollback?.toStage ?? null}
        onClose={() => setActiveRunRollback(null)}
      />

      {/* ── Board columns ── */}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <DndContext
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <div className="flex h-full items-start gap-3">
            {visibleStages.map((stage) => (
              <BoardColumn
                key={stage}
                stage={stage}
                items={grouped[stage] ?? []}
                isLoading={isLoading}
                draggingFromStage={
                  (activeDragItem?.currentStageName as StageName) ?? null
                }
              />
            ))}
          </div>

          <DragOverlay dropAnimation={null}>
            {activeDragItem ? (
              <div className="w-[280px] rotate-1 shadow-xl">
                <WorkItemCard item={activeDragItem} />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>
    </div>
  );
}
