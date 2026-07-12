import { useState, useMemo } from "react";
import { toast } from "sonner";
import {
  useQueue,
  useDequeueWorkItem,
  useWorkItems,
  useApprovals,
  useApproveGate,
  useRejectGate,
} from "@/hooks/use-tracker";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  IconLoader2,
  IconPlayerPause,
  IconPlayerPlay,
  IconArrowUp,
  IconArrowDown,
  IconX,
  IconCheck,
  IconClock,
  IconGitBranch,
  IconRepeat,
  IconShieldCheck,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import type { QueueItem, TrackerWorkItem, Approval, GateKey } from "@shared/types";
import { GATE_KEY_LABELS as gateLabels } from "@shared/types";

// ── Status presentation ─────────────────────────────────────────────────────

function statusBadge(status: string) {
  switch (status) {
    case "running":
    case "运行中":
      return (
        <Badge
          variant="default"
          className="bg-blue-500 text-white animate-pulse"
        >
          运行中
        </Badge>
      );
    case "queued":
    case "排队中":
      return (
        <Badge variant="secondary" className="bg-amber-400/20 text-amber-600">
          排队中
        </Badge>
      );
    case "paused":
    case "已暂停":
      return (
        <Badge variant="secondary" className="bg-gray-400/20 text-gray-500">
          已暂停
        </Badge>
      );
    case "done":
    case "已完成":
      return (
        <Badge variant="secondary" className="bg-emerald-400/20 text-emerald-600">
          已完成
        </Badge>
      );
    case "failed":
    case "失败":
      return (
        <Badge variant="destructive">失败</Badge>
      );
    case "blocked":
    case "等待依赖":
      return (
        <Badge variant="secondary" className="bg-orange-400/20 text-orange-600">
          等待依赖
        </Badge>
      );
    default:
      return (
        <Badge variant="outline">{status}</Badge>
      );
  }
}

function stageBadge(stage: string) {
  const colorMap: Record<string, string> = {
    待办: "bg-slate-400/20 text-slate-600",
    分析: "bg-purple-400/20 text-purple-600",
    设计: "bg-indigo-400/20 text-indigo-600",
    实施: "bg-blue-400/20 text-blue-600",
    测试: "bg-cyan-400/20 text-cyan-600",
    验收: "bg-amber-400/20 text-amber-600",
    交付: "bg-emerald-400/20 text-emerald-600",
  };
  return (
    <Badge
      variant="secondary"
      className={cn(
        colorMap[stage] || "bg-muted text-muted-foreground",
      )}
    >
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

// ── Queue row ───────────────────────────────────────────────────────────────

function QueueRow({
  item,
  index,
  onRemove,
  onMoveUp,
  onMoveDown,
  canUp,
  canDown,
  isReconcilerPaused,
}: {
  item: QueueItem;
  index: number;
  onRemove: (id: string) => void;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
  canUp: boolean;
  canDown: boolean;
  isReconcilerPaused: boolean;
}) {
  const w: TrackerWorkItem | undefined = item.workItem;

  return (
    <div
      className={cn(
        "group flex items-center gap-3 rounded-lg border border-border px-4 py-2.5 transition-colors hover:bg-accent/40",
        item.status === "running" ? "ring-1 ring-blue-400/30" : "",
      )}
    >
      {/* Number */}
      <span className="font-mono text-xs font-medium text-muted-foreground tabular-nums">
        {index + 1}
      </span>

      {/* itemKey + title */}
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
          <span className="truncate text-sm font-medium">
            {w?.title ?? "—"}
          </span>
        </div>
      </div>

      {/* Current stage */}
      {w?.currentStageName ? stageBadge(w.currentStageName) : null}

      {/* Sprint tag */}
      {w?.branch ? (
        <span className="hidden items-center gap-1 font-mono text-[10px] text-muted-foreground md:flex">
          <IconGitBranch className="size-3" />
          {w.branch}
        </span>
      ) : null}

      {/* Time */}
      <span className="hidden items-center gap-1 text-[11px] text-muted-foreground sm:flex">
        <IconClock className="size-3" />
        {fmtTime(item.enqueuedAt)}
      </span>

      {/* 下一步 hint */}
      <span className="hidden text-xs text-muted-foreground lg:block">
        下一步: {getNextStep(item, w)}
      </span>

      {/* Status badge */}
      {statusBadge(item.status)}

      {/* Actions */}
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        {canUp && !isReconcilerPaused ? (
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            onClick={() => onMoveUp(item.id)}
            title="上移"
          >
            <IconArrowUp className="size-3.5" />
          </Button>
        ) : null}
        {canDown && !isReconcilerPaused ? (
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            onClick={() => onMoveDown(item.id)}
            title="下移"
          >
            <IconArrowDown className="size-3.5" />
          </Button>
        ) : null}
        <Button
          size="icon"
          variant="ghost"
          className="size-7 text-destructive"
          onClick={() => onRemove(item.id)}
          title="移除"
        >
          <IconX className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

function getNextStep(item: QueueItem, w?: TrackerWorkItem): string {
  if (item.status === "running" || item.status === "运行中") {
    return "等待当前阶段完成";
  }
  if (item.status === "paused" || item.status === "已暂停") {
    return "等待人工审批";
  }
  if (item.status === "blocked" || item.status === "等待依赖") {
    try {
      const blockers = item.blockedBy ? JSON.parse(item.blockedBy) : [];
      const keys = Array.isArray(blockers)
        ? blockers
            .map((b: { itemKey?: string } | string) =>
              typeof b === "string" ? b : b?.itemKey,
            )
            .filter(Boolean)
        : [];
      return keys.length ? `等待依赖 ${keys.join(", ")}` : "等待依赖";
    } catch {
      return "等待依赖";
    }
  }
  if (w?.currentStageName) {
    const order = ["待办", "分析", "设计", "实施", "测试", "验收", "交付"];
    const idx = order.indexOf(w.currentStageName);
    if (idx >= 0 && idx < order.length - 1) {
      return `进入「${order[idx + 1]}」`;
    }
  }
  return "等待调度";
}

// ── Human gate card ─────────────────────────────────────────────────────────

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
            {w?.itemKey ? (
              <span
                className="font-mono text-xs font-semibold text-muted-foreground"
                title={
                  w.itemKeyDisplay && w.itemKeyDisplay !== w.itemKey
                    ? "历史重号，已消歧显示"
                    : undefined
                }
              >
                {w.itemKeyDisplay ?? w.itemKey}
              </span>
            ) : null}
            <span className="truncate text-sm font-medium">
              {w?.title ?? "—"}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            {w?.currentStageName ? stageBadge(w.currentStageName) : null}
            <span className="flex items-center gap-1">
              <IconClock className="size-3" />
              {fmtTime(item.enqueuedAt)}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
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
            <IconShieldCheck className="size-4 text-amber-500 shrink-0" />
            <span className="text-sm font-medium">
              {gateLabels[approval.gateKey as GateKey] ?? approval.gateKey}
            </span>
            <Badge variant="secondary" className="bg-amber-400/20 text-amber-700">
              待审批
            </Badge>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
            <span>Sprint: {approval.sprintId}</span>
            {approval.workItemId ? <span>工作项: {approval.workItemId}</span> : null}
            <span className="flex items-center gap-1">
              <IconClock className="size-3" />
              {approval.createdAt?.slice(0, 16).replace("T", " ") ?? "—"}
            </span>
            <span>发起人: {approval.requestedBy}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
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
    void rejectGate.mutateAsync({ id: approvalId, reason: reason.trim() }).then(onClose);
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

// ── Main page ───────────────────────────────────────────────────────────────

export function QueuePage() {
  const { data: queueData, isLoading } = useQueue();
  const { data: allItemsData } = useWorkItems();
  const dequeue = useDequeueWorkItem();
  const { data: pendingApprovalsData, isLoading: approvalsLoading } = useApprovals({ status: "pending" });
  const approveGate = useApproveGate();

  const items: QueueItem[] = useMemo(
    () => (Array.isArray(queueData) ? queueData : []),
    [queueData],
  );

  const pendingApprovals: Approval[] = useMemo(
    () => (Array.isArray(pendingApprovalsData) ? pendingApprovalsData : []),
    [pendingApprovalsData],
  );

  const [reconcilerPaused, setReconcilerPaused] = useState(false);
  const [reconcilerToggleLoading, setReconcilerToggleLoading] =
    useState(false);
  const [rejectTarget, setRejectTarget] = useState<string | null>(null);

  // Stats
  const queuedCount = items.filter(
    (it) => it.status === "queued" || it.status === "排队中",
  ).length;
  const runningCount = items.filter(
    (it) => it.status === "running" || it.status === "运行中",
  ).length;
  const failedCount = items.filter(
    (it) => it.status === "failed" || it.status === "待审批",
  ).length;
  const todayDoneCount = useMemo(() => {
    const allItems = Array.isArray(allItemsData) ? allItemsData : [];
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    return allItems.filter((it: any) => {
      if (it.status !== "done") return false;
      const updatedAt = it.updatedAt ? new Date(it.updatedAt) : null;
      return updatedAt && updatedAt >= todayStart;
    }).length;
  }, [allItemsData]);

  // Human gate items (paused items awaiting approval)
  const humanGateItems = items.filter(
    (it) => it.status === "paused" || it.status === "待审批",
  );

  const [order, setOrder] = useState<string[]>(
    items.map((it) => it.id),
  );

  function handleRemove(id: string) {
    void dequeue.mutateAsync({ workItemId: id });
    setOrder((prev) => prev.filter((oid) => oid !== id));
    toast.success("已从队列移除");
  }

  function handleMoveUp(id: string) {
    setOrder((prev) => {
      const idx = prev.indexOf(id);
      if (idx <= 0) return prev;
      const next = [...prev];
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      return next;
    });
  }

  function handleMoveDown(id: string) {
    setOrder((prev) => {
      const idx = prev.indexOf(id);
      if (idx < 0 || idx >= prev.length - 1) return prev;
      const next = [...prev];
      [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
      return next;
    });
  }

  function handleApprove(id: string) {
    toast.success("已批准，入队继续");
    // In a real app, would call an approve action. For now, just reorder.
  }

  function handleReject(id: string) {
    toast.info("已驳回");
    handleRemove(id);
  }

  function handleApprovalApprove(approvalId: string) {
    void approveGate.mutateAsync({ id: approvalId });
  }

  function handleApprovalReject(approvalId: string) {
    setRejectTarget(approvalId);
  }

  async function toggleReconciler() {
    setReconcilerToggleLoading(true);
    try {
      setReconcilerPaused((p) => !p);
      toast.success(
        reconcilerPaused ? "Reconciler 已恢复" : "Reconciler 已暂停",
      );
    } finally {
      setReconcilerToggleLoading(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* ── Header ── */}
      <div className="flex items-center justify-between border-b border-border px-6 py-3">
        <h2 className="text-base font-semibold tracking-tight">
          执行队列
        </h2>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={toggleReconciler}
          disabled={reconcilerToggleLoading}
        >
          {reconcilerToggleLoading ? (
            <IconLoader2 className="size-4 animate-spin" />
          ) : reconcilerPaused ? (
            <IconPlayerPlay className="size-4" />
          ) : (
            <IconPlayerPause className="size-4" />
          )}
          {reconcilerPaused ? "▶ 恢复 reconciler" : "⏸ 暂停 reconciler"}
        </Button>
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-auto p-6">
        {/* ── Stats row ── */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            label="队列中"
            value={String(queuedCount)}
            accent="bg-amber-500"
          />
          <StatCard
            label="运行中"
            value={String(runningCount)}
            accent="bg-blue-500"
          />
          <StatCard
            label="今日完成"
            value={String(todayDoneCount)}
            accent="bg-emerald-500"
          />
          <StatCard
            label="失败 · 待审批"
            value={String(failedCount + pendingApprovals.length)}
            accent="bg-destructive"
          />
        </div>

        {/* ── Reconciler status ── */}
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3 p-4">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "size-2.5 rounded-full",
                  reconcilerPaused
                    ? "bg-gray-400"
                    : "bg-emerald-500 animate-pulse",
                )}
              />
              <span className="text-sm font-medium">
                {reconcilerPaused
                  ? "● reconciler 已暂停"
                  : "● reconciler 运行中"}
              </span>
            </div>
            <span className="text-xs text-muted-foreground">
              节流 2s · 并发上限 3
            </span>
            <div className="ml-auto flex items-center gap-2">
              {items
                .filter(
                  (it) =>
                    it.status === "running" ||
                    it.status === "运行中",
                )
                .slice(0, 3)
                .map((it) => {
                  const w = it.workItem;
                  return (
                    <Badge
                      key={it.id}
                      variant="outline"
                      className="gap-1 text-xs"
                    >
                      {w?.itemKeyDisplay ?? w?.itemKey ?? "—"}
                    </Badge>
                  );
                })}
            </div>
          </CardContent>
        </Card>

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

        {/* ── Queue list ── */}
        <div className="space-y-1">
          <h3 className="mb-2 text-sm font-semibold text-muted-foreground">
            队列 ({items.length})
          </h3>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className="h-14 animate-pulse rounded-lg border border-border bg-muted/40"
                />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 text-center">
              <p className="text-sm text-muted-foreground">
                队列为空。工作项将在创建或入队后出现在这里。
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {order.map((itemId, i) => {
                const it = items.find((x) => x.id === itemId);
                if (!it) return null;
                return (
                  <QueueRow
                    key={it.id}
                    item={it}
                    index={i}
                    onRemove={handleRemove}
                    onMoveUp={handleMoveUp}
                    onMoveDown={handleMoveDown}
                    canUp={i > 0}
                    canDown={i < order.length - 1}
                    isReconcilerPaused={reconcilerPaused}
                  />
                );
              })}
            </div>
          )}
        </div>

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

// ── Stat card ───────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <span className={cn("size-2.5 shrink-0 rounded-full", accent)} />
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-2xl font-bold tabular-nums">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}
