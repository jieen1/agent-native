import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type {
  QueueItem,
  TrackerWorkItem,
  Approval,
  GateKey,
  QueueHealthStatus,
} from "@shared/types";
import { GATE_KEY_LABELS as gateLabels } from "@shared/types";
import {
  IconLoader2,
  IconPlayerPause,
  IconPlayerPlay,
  IconX,
  IconCheck,
  IconClock,
  IconGitBranch,
  IconRepeat,
  IconShieldCheck,
  IconExternalLink,
  IconRocket,
  IconGripVertical,
  IconPinned,
  IconAlertTriangle,
  IconCloudOff,
} from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";

import { StatusIcon, type StatusIconTone } from "@/components/StatusIcon";
import { StatusRing } from "@/components/StatusRing";
import { stageChip, inboxKindChip } from "@/components/tracker-format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useQueue,
  useDequeueWorkItem,
  useEnqueueWorkItem,
  useWorkItems,
  useApprovals,
  useApproveGate,
  useRejectGate,
  useDispatch,
  usePauseScheduler,
  useResumeScheduler,
  useQueueHealth,
  useReorderQueue,
} from "@/hooks/use-tracker";
import {
  QUEUE_GROUP_LABELS,
  type QueueGroupKey,
  computeQueueStatsCards,
  groupQueueItems,
  moveIdBetween,
  moveIdToTop,
  queueGroupOf,
  waitingLabel,
} from "@/lib/queue";
import { cn } from "@/lib/utils";

import { resolveWorkItemId, runQueueGateAction } from "./queue-gate-actions";

// ── Status presentation ─────────────────────────────────────────────────────

function stageBadge(stage: string) {
  return (
    <Badge variant="secondary" className={cn(stageChip(stage))}>
      {stage}
    </Badge>
  );
}

function fmtTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatElapsed(sinceIso: string, nowMs: number): string {
  const since = new Date(sinceIso).getTime();
  if (!Number.isFinite(since)) return "—";
  const seconds = Math.max(0, Math.floor((nowMs - since) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Ticks every second — the running group's row timer anchors on the work
 *  item's real `dispatchedAt` (exec_queue.startedAt is never actually
 *  written by any action, so it can't back an honest timer). */
function ElapsedTimer({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground tabular-nums">
      <IconClock className="size-3" />
      {formatElapsed(since, now)}
    </span>
  );
}

// ── Row title (shared by every group) ───────────────────────────────────────

function RowTitle({ w }: { w?: TrackerWorkItem }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        {w?.itemKey ? (
          <span
            className="font-mono text-[11px] font-semibold text-muted-foreground"
            title={
              w.itemKeyDisplay && w.itemKeyDisplay !== w.itemKey
                ? "历史重号，已消歧显示"
                : undefined
            }
          >
            {w.itemKeyDisplay ?? w.itemKey}
          </span>
        ) : null}
        <span className="truncate text-sm font-medium">{w?.title ?? "—"}</span>
      </div>
    </div>
  );
}

// ── Row actions (shared by dispatchable / dependency / health groups) ──────

function RowActions({
  item,
  onRemove,
  onDispatch,
  dispatchPending,
  schedulerPaused,
}: {
  item: QueueItem;
  onRemove: (id: string) => void;
  onDispatch: (item: QueueItem) => void;
  dispatchPending: boolean;
  schedulerPaused: boolean;
}) {
  const workItemId = item.workItemId;
  return (
    <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              disabled={dispatchPending || schedulerPaused}
              onClick={() => onDispatch(item)}
              title="立即派发（过门检查）"
            >
              {dispatchPending ? (
                <IconLoader2 className="size-3.5 animate-spin" />
              ) : (
                <IconRocket className="size-3.5" />
              )}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {schedulerPaused ? "调度器已暂停，无法派发" : "立即派发（过门检查）"}
        </TooltipContent>
      </Tooltip>
      <Button
        size="icon"
        variant="ghost"
        className="size-7"
        asChild
        title="打开工作项"
      >
        <Link to={`/items/${encodeURIComponent(workItemId)}`}>
          <IconExternalLink className="size-3.5" />
        </Link>
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="size-7 text-destructive"
        onClick={() => onRemove(item.id)}
        title="出队"
      >
        <IconX className="size-3.5" />
      </Button>
    </div>
  );
}

// ── Running row ──────────────────────────────────────────────────────────────

function RunningRow({ item }: { item: QueueItem }) {
  const w = item.workItem;
  return (
    <div className="group flex items-center gap-3 rounded-lg border border-info/30 bg-info/5 px-4 py-2.5">
      <StatusRing status="running" />
      <RowTitle w={w} />
      {w?.currentStageName ? stageBadge(w.currentStageName) : null}
      {w?.dispatchedAt ? <ElapsedTimer since={w.dispatchedAt} /> : null}
      <div className="ml-auto flex items-center gap-1">
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          asChild
          title="打开工作项"
        >
          <Link to={`/items/${encodeURIComponent(item.workItemId)}`}>
            <IconExternalLink className="size-3.5" />
          </Link>
        </Button>
      </div>
    </div>
  );
}

// ── Waiting row (dependency / health) ────────────────────────────────────────

function WaitingRow({
  item,
  onRemove,
  onDispatch,
  dispatchPending,
  schedulerPaused,
  justCleared,
}: {
  item: QueueItem;
  onRemove: (id: string) => void;
  onDispatch: (item: QueueItem) => void;
  dispatchPending: boolean;
  schedulerPaused: boolean;
  justCleared?: boolean;
}) {
  const w = item.workItem;
  const label = waitingLabel(item);
  return (
    <div
      className={cn(
        "group flex items-center gap-3 rounded-lg border border-border px-4 py-2.5 transition-colors hover:bg-accent/40",
        justCleared && "animate-in fade-in slide-in-from-top-2 duration-500",
      )}
    >
      <StatusRing status="gate" />
      <RowTitle w={w} />
      {w?.currentStageName ? stageBadge(w.currentStageName) : null}
      {label ? (
        <Badge
          variant="secondary"
          className="max-w-[16rem] truncate bg-warning/10 text-warning border-warning/30"
          title={label}
        >
          {label}
        </Badge>
      ) : null}
      <RowActions
        item={item}
        onRemove={onRemove}
        onDispatch={onDispatch}
        dispatchPending={dispatchPending}
        schedulerPaused={schedulerPaused}
      />
    </div>
  );
}

// ── Dispatchable row (draggable) ─────────────────────────────────────────────

function DispatchableRow({
  item,
  onRemove,
  onDispatch,
  onPinToTop,
  dispatchPending,
  schedulerPaused,
}: {
  item: QueueItem;
  onRemove: (id: string) => void;
  onDispatch: (item: QueueItem) => void;
  onPinToTop: (workItemId: string) => void;
  dispatchPending: boolean;
  schedulerPaused: boolean;
}) {
  const w = item.workItem;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.workItemId });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group flex items-center gap-2 rounded-lg border border-border px-3 py-2.5 transition-colors hover:bg-accent/40",
        isDragging && "opacity-60 ring-2 ring-primary/40",
      )}
    >
      <button
        type="button"
        className="cursor-grab touch-none text-muted-foreground/60 hover:text-foreground active:cursor-grabbing"
        aria-label="拖拽排序"
        {...attributes}
        {...listeners}
      >
        <IconGripVertical className="size-4" />
      </button>
      <StatusRing status="queued" />
      <RowTitle w={w} />
      {w?.currentStageName ? stageBadge(w.currentStageName) : null}
      {w?.branch ? (
        <span className="hidden max-w-[12rem] items-center gap-1 truncate font-mono text-[10px] text-muted-foreground md:flex">
          <IconGitBranch className="size-3 shrink-0" />
          <span className="truncate">{w.branch}</span>
        </span>
      ) : null}
      <span className="hidden items-center gap-1 text-[11px] text-muted-foreground sm:flex">
        <IconClock className="size-3" />
        {fmtTime(item.enqueuedAt)}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="size-7 opacity-0 transition-opacity group-hover:opacity-100"
            onClick={() => onPinToTop(item.workItemId)}
          >
            <IconPinned className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>置顶</TooltipContent>
      </Tooltip>
      <RowActions
        item={item}
        onRemove={onRemove}
        onDispatch={onDispatch}
        dispatchPending={dispatchPending}
        schedulerPaused={schedulerPaused}
      />
    </div>
  );
}

// ── Group section wrapper ────────────────────────────────────────────────────

function GroupHeading({
  groupKey,
  count,
}: {
  groupKey: QueueGroupKey;
  count: number;
}) {
  return (
    <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
      {QUEUE_GROUP_LABELS[groupKey]}
      <span className="font-mono text-xs tabular-nums">{count}</span>
    </h3>
  );
}

// ── Human gate card (unchanged real feature — see queue-gate-actions.ts) ────

function HumanGateCard({
  item,
  onApprove,
  onReject,
}: {
  item: QueueItem;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const w = item.workItem;

  return (
    <Card className="border-border/80">
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <StatusIcon tone="warn" size="sm" />
            <RowTitle w={w} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            {w?.currentStageName ? stageBadge(w.currentStageName) : null}
            <span className="flex items-center gap-1">
              <IconClock className="size-3" />
              {fmtTime(item.enqueuedAt)}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="default"
            className="gap-1"
            onClick={() => onApprove(item.id)}
          >
            <IconCheck className="size-3.5" />
            批准
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1"
            onClick={() => onReject(item.id)}
          >
            <IconRepeat className="size-3.5" />
            驳回
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Approval gate card (queue page) ─────────────────────────────────────────

function QueueApprovalCard({
  approval,
  onApprove,
  onReject,
}: {
  approval: Approval;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  return (
    <Card className="border-border/80">
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <IconShieldCheck className="size-4 text-warning shrink-0" />
            <span className="text-sm font-medium">
              {gateLabels[approval.gateKey as GateKey] ?? approval.gateKey}
            </span>
            <Badge
              variant="secondary"
              className={inboxKindChip("pending-approval")}
            >
              待审批
            </Badge>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
            <span>Sprint: {approval.sprintId}</span>
            {approval.workItemId ? (
              <span>工作项: {approval.workItemId}</span>
            ) : null}
            <span className="flex items-center gap-1">
              <IconClock className="size-3" />
              {approval.createdAt?.slice(0, 16).replace("T", " ") ?? "—"}
            </span>
            <span>发起人: {approval.requestedBy}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="default"
            className="gap-1"
            onClick={() => onApprove(approval.id)}
          >
            <IconCheck className="size-3.5" />
            批准
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1"
            onClick={() => onReject(approval.id)}
          >
            <IconRepeat className="size-3.5" />
            驳回
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Queue reject dialog ──────────────────────────────────────────────────────

function QueueRejectDialog({
  approvalId,
  open,
  onClose,
}: {
  approvalId: string;
  open: boolean;
  onClose: () => void;
}) {
  const rejectGate = useRejectGate();
  const [reason, setReason] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason.trim()) return;
    void rejectGate
      .mutateAsync({ id: approvalId, reason: reason.trim() })
      .then(onClose);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>驳回原因</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="rejectReason">原因（必填）</Label>
            <Input
              id="rejectReason"
              placeholder="请填写驳回原因"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={rejectGate.isPending || !reason.trim()}
            >
              {rejectGate.isPending ? "提交中…" : "确认驳回"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Health status bar (03-tracker.md §8: vLLM · CC 登录 · brain 槽位 + 最近拒绝) ──

function HealthDot({
  tone,
  label,
  detail,
}: {
  tone: StatusIconTone;
  label: string;
  detail: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex items-center gap-1.5 text-xs">
          <StatusIcon tone={tone} size="sm" aria-label={label} />
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent>{detail}</TooltipContent>
    </Tooltip>
  );
}

function HealthStatusBar({ health }: { health?: QueueHealthStatus }) {
  if (!health) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
          <IconLoader2 className="size-3.5 animate-spin" />
          读取健康门状态…
        </CardContent>
      </Card>
    );
  }

  if (!health.orchestratorReachable) {
    return (
      <Card className="border-destructive/30 bg-destructive/5">
        <CardContent className="flex items-center gap-2 p-4 text-xs text-destructive">
          <IconCloudOff className="size-4 shrink-0" />
          编排器不可达（{health.orchestratorError ?? "连接失败"}）——
          健康门状态暂不可读，出于诚实原则不展示伪造的健康态。
        </CardContent>
      </Card>
    );
  }

  const ccOk = !!health.claudeCode?.loggedIn && !health.claudeCode.expired;
  const brainOk = !!health.brain?.driverAlive;
  const vllmConfigured = !!health.devEngine?.configured;

  return (
    <TooltipProvider delayDuration={150}>
      <Card>
        <CardContent className="flex flex-wrap items-center gap-4 p-4">
          <HealthDot
            tone={vllmConfigured ? "ok" : "warn"}
            label="vLLM"
            detail={
              vllmConfigured
                ? `已配置：${health.devEngine?.model ?? "?"} @ ${health.devEngine?.baseUrl ?? "?"}`
                : "未配置开发引擎（未探测网络可达性，仅报告配置状态）"
            }
          />
          <HealthDot
            tone={ccOk ? "ok" : "err"}
            label="CC 登录"
            detail={
              health.claudeCode == null
                ? "未知"
                : health.claudeCode.expired
                  ? "登录已过期，需重新登录"
                  : health.claudeCode.loggedIn
                    ? `已登录${health.claudeCode.subscription ? `（${health.claudeCode.subscription}）` : ""}`
                    : "未登录"
            }
          />
          <HealthDot
            tone={brainOk ? "ok" : "err"}
            label="brain 槽位"
            detail={
              health.brain == null
                ? "未知"
                : `driver ${health.brain.driverAlive ? "存活" : "无响应"} · 运行 ${health.brain.running} · 排队 ${health.brain.queued} · 上限 ${health.brain.concurrency ?? "?"}${health.brain.lastError ? ` · 最近错误：${health.brain.lastError}` : ""}`
            }
          />
          {health.brain ? (
            <span className="font-mono text-[11px] text-muted-foreground">
              运行 {health.brain.running} · 排队 {health.brain.queued} · 上限{" "}
              {health.brain.concurrency ?? "?"}
            </span>
          ) : null}
          <div className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {health.lastRejection ? (
              <>
                <IconAlertTriangle className="size-3.5 shrink-0 text-warning" />
                最近拒绝：{health.lastRejection.reason} ·{" "}
                {fmtTime(health.lastRejection.at)}
              </>
            ) : (
              "暂无拒绝记录"
            )}
          </div>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}

// ── Stat card ───────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "warning" | "info" | "success" | "destructive" | "muted";
}) {
  const dotClass =
    tone === "warning"
      ? "bg-warning"
      : tone === "info"
        ? "bg-info"
        : tone === "success"
          ? "bg-success"
          : tone === "destructive"
            ? "bg-destructive"
            : "bg-muted-foreground";
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <span className={cn("size-2.5 shrink-0 rounded-full", dotClass)} />
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-2xl font-bold tabular-nums">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Scheduler warning banner ─────────────────────────────────────────────────

function SchedulerPausedBanner({
  pausedAt,
  pausedBy,
}: {
  pausedAt: string | null;
  pausedBy: string | null;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-warning/40 bg-warning/10 px-4 py-2.5 text-sm text-warning">
      <IconAlertTriangle className="size-4 shrink-0" />
      <span className="font-medium">调度器已暂停</span>
      <span className="text-xs text-warning/90">
        新的派发请求会被拒绝，队列中的项不会被处理
        {pausedAt ? ` · 暂停于 ${fmtTime(pausedAt)}` : ""}
        {pausedBy ? ` · 操作人 ${pausedBy}` : ""}
      </span>
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────

export function QueuePage() {
  const { data: queueData, isLoading } = useQueue();
  const { data: allItemsData } = useWorkItems();
  const dequeue = useDequeueWorkItem();
  const enqueueWorkItem = useEnqueueWorkItem();
  const dispatch = useDispatch();
  const { data: pendingApprovalsData, isLoading: approvalsLoading } =
    useApprovals({ status: "pending" });
  const approveGate = useApproveGate();
  const { data: health } = useQueueHealth();
  const pauseScheduler = usePauseScheduler();
  const resumeScheduler = useResumeScheduler();
  const reorderQueue = useReorderQueue();

  const items: QueueItem[] = useMemo(
    () => (Array.isArray(queueData?.items) ? queueData!.items : []),
    [queueData],
  );

  const pendingApprovals: Approval[] = useMemo(
    () => (Array.isArray(pendingApprovalsData) ? pendingApprovalsData : []),
    [pendingApprovalsData],
  );

  const [rejectTarget, setRejectTarget] = useState<string | null>(null);
  const [dispatchingId, setDispatchingId] = useState<string | null>(null);
  // Optimistic hide for human-gate rows: added when approve/reject is
  // in flight, removed again if the underlying action fails so the row
  // reappears for retry.
  const [hiddenGateIds, setHiddenGateIds] = useState<Set<string>>(new Set());
  // Local override for the dispatchable group's drag order — applied
  // immediately on drop so the row doesn't snap back while reorder-queue's
  // mutation + the next poll settle (see handleDragEnd).
  const [orderOverride, setOrderOverride] = useState<string[] | null>(null);

  const schedulerPaused = !!health?.scheduler.paused;

  // Human gate items (paused items awaiting approval) — kept as its own
  // section (distinct IA concept from the 4 scheduling groups below); see
  // the queue-gate-actions.ts docblock and the report's IA note (§2 signoff
  // semantics reused here, not folded into the 4 groups).
  const humanGateItems = items.filter(
    (it) =>
      (it.status === "paused" || it.status === "待审批") &&
      !hiddenGateIds.has(it.id),
  );
  const schedulingItems = items.filter((it) => !humanGateItems.includes(it));

  const groups = useMemo(
    () => groupQueueItems(schedulingItems),
    [schedulingItems],
  );

  const dispatchableOrdered = useMemo(() => {
    if (!orderOverride) return groups.dispatchable;
    const byId = new Map(groups.dispatchable.map((it) => [it.workItemId, it]));
    const ordered = orderOverride
      .map((id) => byId.get(id))
      .filter((it): it is QueueItem => !!it);
    // Any row not covered by the override (e.g. freshly enqueued mid-drag) is
    // appended at the end rather than dropped.
    for (const it of groups.dispatchable) {
      if (!orderOverride.includes(it.workItemId)) ordered.push(it);
    }
    return ordered;
  }, [groups.dispatchable, orderOverride]);

  // Track which rows were in "等待依赖" on the previous render so a row that
  // just cleared its dependency gate gets a one-shot slide/fade animation in
  // its new group (design: "依赖解除时的自动上移动画").
  const prevGroupRef = useRef<Map<string, QueueGroupKey>>(new Map());
  const justClearedIds = useMemo(() => {
    const prev = prevGroupRef.current;
    const cleared = new Set<string>();
    for (const item of schedulingItems) {
      if (
        prev.get(item.id) === "dependency" &&
        queueGroupOf(item) !== "dependency"
      ) {
        cleared.add(item.id);
      }
    }
    return cleared;
  }, [schedulingItems]);
  useEffect(() => {
    const next = new Map<string, QueueGroupKey>();
    for (const item of schedulingItems) next.set(item.id, queueGroupOf(item));
    prevGroupRef.current = next;
  }, [schedulingItems]);

  const stats = useMemo(
    () =>
      computeQueueStatsCards(
        groups,
        Array.isArray(allItemsData) ? allItemsData : [],
      ),
    [groups, allItemsData],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const currentIds = dispatchableOrdered.map((it) => it.workItemId);
    const nextIds = moveIdBetween(
      currentIds,
      String(active.id),
      String(over.id),
    );
    setOrderOverride(nextIds);
    reorderQueue.mutate(
      { workItemIds: nextIds },
      {
        onSuccess: () => setOrderOverride(null),
        onError: () => setOrderOverride(null),
      },
    );
  }

  function handlePinToTop(workItemId: string) {
    const currentIds = dispatchableOrdered.map((it) => it.workItemId);
    const nextIds = moveIdToTop(currentIds, workItemId);
    setOrderOverride(nextIds);
    reorderQueue.mutate(
      { workItemIds: nextIds },
      {
        onSuccess: () => {
          setOrderOverride(null);
          toast.success("已置顶");
        },
        onError: () => setOrderOverride(null),
      },
    );
  }

  function handleRemove(id: string) {
    // `id` here is the QueueItem (exec_queue row) id, not the work item id —
    // resolve the real work item id before calling the backend action.
    const workItemId = resolveWorkItemId(items, id);
    void dequeue.mutateAsync({ workItemId });
    toast.success("已从队列移除");
  }

  function handleDispatch(item: QueueItem) {
    setDispatchingId(item.id);
    dispatch.mutate(
      { workItemId: item.workItemId },
      {
        onSuccess: (result: unknown) => {
          const status = (result as { status?: string } | undefined)?.status;
          if (status === "blocked") {
            toast.warning("仍被依赖门阻塞，未派发");
          } else {
            toast.success("已派发");
          }
        },
        onSettled: () => setDispatchingId(null),
      },
    );
  }

  function unhideGateRow(id: string) {
    setHiddenGateIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  function hideGateRow(id: string) {
    setHiddenGateIds((prev) => new Set(prev).add(id));
  }

  // Approving a human-gate queue row means letting it continue: re-admit it
  // through the real enqueue-work-item action (the same admission path a
  // fresh enqueue uses), rather than a UI-only toast.
  function handleApprove(id: string) {
    void runQueueGateAction({
      id,
      items,
      mutateAsync: (vars) => enqueueWorkItem.mutateAsync(vars),
      hide: hideGateRow,
      unhide: unhideGateRow,
      onSuccess: () => toast.success("已批准，重新入队"),
      onError: () => toast.error("批准失败，请重试"),
    });
  }

  // Rejecting a human-gate queue row means kicking it out of the queue via
  // the real dequeue-work-item action.
  function handleReject(id: string) {
    void runQueueGateAction({
      id,
      items,
      mutateAsync: (vars) => dequeue.mutateAsync(vars),
      hide: hideGateRow,
      unhide: unhideGateRow,
      onSuccess: () => toast.success("已驳回，移出队列"),
      onError: () => toast.error("驳回失败，请重试"),
    });
  }

  function handleApprovalApprove(approvalId: string) {
    void approveGate.mutateAsync({ id: approvalId });
  }

  function handleApprovalReject(approvalId: string) {
    setRejectTarget(approvalId);
  }

  function toggleScheduler() {
    if (schedulerPaused) {
      resumeScheduler.mutate(
        {},
        { onSuccess: () => toast.success("调度器已恢复") },
      );
    } else {
      pauseScheduler.mutate(
        {},
        { onSuccess: () => toast.success("调度器已暂停") },
      );
    }
  }

  const schedulerToggleLoading =
    pauseScheduler.isPending || resumeScheduler.isPending;

  const emptyScheduling =
    groups.running.length === 0 &&
    dispatchableOrdered.length === 0 &&
    groups.dependency.length === 0 &&
    groups.health.length === 0;

  return (
    <div className="flex h-full flex-col">
      {/* ── Header ── */}
      <div className="flex items-center justify-between border-b border-border px-6 py-3">
        <h2 className="text-base font-semibold tracking-tight">执行队列</h2>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={toggleScheduler}
          disabled={schedulerToggleLoading}
        >
          {schedulerToggleLoading ? (
            <IconLoader2 className="size-4 animate-spin" />
          ) : schedulerPaused ? (
            <IconPlayerPlay className="size-4" />
          ) : (
            <IconPlayerPause className="size-4" />
          )}
          {schedulerPaused ? "恢复调度器" : "暂停调度器"}
        </Button>
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-auto p-6">
        {schedulerPaused ? (
          <SchedulerPausedBanner
            pausedAt={health?.scheduler.pausedAt ?? null}
            pausedBy={health?.scheduler.pausedBy ?? null}
          />
        ) : null}

        {/* ── Stats row ── */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard label="排队" value={String(stats.queued)} tone="warning" />
          <StatCard label="运行中" value={String(stats.running)} tone="info" />
          <StatCard
            label="等待依赖"
            value={String(stats.dependency)}
            tone="warning"
          />
          <StatCard
            label="等待健康门"
            value={String(stats.health)}
            tone="destructive"
          />
          <StatCard
            label="今日完成"
            value={String(stats.doneToday)}
            tone="success"
          />
          <StatCard
            label="失败"
            value={String(stats.failed)}
            tone="destructive"
          />
        </div>

        {/* ── Health status bar ── */}
        <HealthStatusBar health={health} />

        {/* ── Pending approvals (real data) ── */}
        {approvalsLoading ? (
          <div className="space-y-2">
            <div className="h-4 w-32 animate-pulse rounded bg-muted/40" />
            <div className="h-16 animate-pulse rounded-lg border border-border bg-muted/40" />
          </div>
        ) : pendingApprovals.length > 0 ? (
          <div className="space-y-2">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
              <IconShieldCheck className="size-4" />
              待审批 · {pendingApprovals.length}
            </h3>
            <div className="space-y-2">
              {pendingApprovals.map((approval) => (
                <QueueApprovalCard
                  key={approval.id}
                  approval={approval}
                  onApprove={handleApprovalApprove}
                  onReject={handleApprovalReject}
                />
              ))}
            </div>
          </div>
        ) : null}

        {/* ── Queue table (grouped: 运行中 / 可派发 / 等待依赖 / 等待健康门) ── */}
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="h-14 animate-pulse rounded-lg border border-border bg-muted/40"
              />
            ))}
          </div>
        ) : emptyScheduling ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 text-center">
            <p className="text-sm text-muted-foreground">
              队列为空。工作项将在创建或入队后出现在这里。
            </p>
          </div>
        ) : (
          <TooltipProvider delayDuration={150}>
            <div className="space-y-5">
              {groups.running.length > 0 ? (
                <div>
                  <GroupHeading
                    groupKey="running"
                    count={groups.running.length}
                  />
                  <div className="space-y-1">
                    {groups.running.map((item) => (
                      <RunningRow key={item.id} item={item} />
                    ))}
                  </div>
                </div>
              ) : null}

              {dispatchableOrdered.length > 0 ? (
                <div>
                  <GroupHeading
                    groupKey="dispatchable"
                    count={dispatchableOrdered.length}
                  />
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                  >
                    <SortableContext
                      items={dispatchableOrdered.map((it) => it.workItemId)}
                      strategy={verticalListSortingStrategy}
                    >
                      <div className="space-y-1">
                        {dispatchableOrdered.map((item) => (
                          <DispatchableRow
                            key={item.id}
                            item={item}
                            onRemove={handleRemove}
                            onDispatch={handleDispatch}
                            onPinToTop={handlePinToTop}
                            dispatchPending={
                              dispatchingId === item.id && dispatch.isPending
                            }
                            schedulerPaused={schedulerPaused}
                          />
                        ))}
                      </div>
                    </SortableContext>
                  </DndContext>
                </div>
              ) : null}

              {groups.dependency.length > 0 ? (
                <div>
                  <GroupHeading
                    groupKey="dependency"
                    count={groups.dependency.length}
                  />
                  <div className="space-y-1">
                    {groups.dependency.map((item) => (
                      <WaitingRow
                        key={item.id}
                        item={item}
                        onRemove={handleRemove}
                        onDispatch={handleDispatch}
                        dispatchPending={
                          dispatchingId === item.id && dispatch.isPending
                        }
                        schedulerPaused={schedulerPaused}
                        justCleared={justClearedIds.has(item.id)}
                      />
                    ))}
                  </div>
                </div>
              ) : null}

              {groups.health.length > 0 ? (
                <div>
                  <GroupHeading
                    groupKey="health"
                    count={groups.health.length}
                  />
                  <div className="space-y-1">
                    {groups.health.map((item) => (
                      <WaitingRow
                        key={item.id}
                        item={item}
                        onRemove={handleRemove}
                        onDispatch={handleDispatch}
                        dispatchPending={
                          dispatchingId === item.id && dispatch.isPending
                        }
                        schedulerPaused={schedulerPaused}
                      />
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </TooltipProvider>
        )}

        {/* ── Human gate (queue-paused items) ── */}
        {humanGateItems.length > 0 ? (
          <div className="space-y-2">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
              等待人工审门 · {humanGateItems.length}
            </h3>
            <div className="space-y-2">
              {humanGateItems.map((it) => (
                <HumanGateCard
                  key={it.id}
                  item={it}
                  onApprove={handleApprove}
                  onReject={handleReject}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {/* ── Reject dialog ── */}
      {rejectTarget ? (
        <QueueRejectDialog
          approvalId={rejectTarget}
          open={!!rejectTarget}
          onClose={() => setRejectTarget(null)}
        />
      ) : null}
    </div>
  );
}
