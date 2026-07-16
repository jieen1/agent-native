import type {
  ScaleEstimate,
  SprintDetail,
  TrackerWorkItem,
  Stage,
  SprintArtifact,
  Approval,
  GateKey,
} from "@shared/types";
import { GATE_KEY_LABELS as gateLabels } from "@shared/types";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconCalendar,
  IconFileText,
  IconGitBranch,
  IconPackage,
  IconPlus,
  IconClock,
  IconCheck,
  IconX,
  IconShieldCheck,
} from "@tabler/icons-react";
import { useState } from "react";
import { useParams } from "react-router";
import { Link } from "react-router";

import { ArtifactBadge, ArtifactViewDialog } from "@/components/ArtifactBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useSprint,
  useSprintArtifacts,
  useApprovals,
  useRequestApproval,
  useApproveGate,
  useRejectGate,
} from "@/hooks/use-tracker";
import { cn } from "@/lib/utils";

// ── Helpers ──────────────────────────────────────────────────────────────────

// F5 (v25): get-sprint.ts returns raw DB rows — scale_estimate arrives as a
// JSON string (or null); parse defensively (see shared/types.ts's
// TrackerWorkItem.scaleEstimate docblock for why this isn't pre-parsed).
function parseScaleEstimate(
  raw: string | null | undefined,
): ScaleEstimate | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ScaleEstimate;
  } catch {
    return null;
  }
}

/** 规模徽标(Briefs 列表行,02 §3.10)— ok=灰点,split-required=warning badge. */
function ScaleBadgeCompact({ raw }: { raw: string | null | undefined }) {
  const estimate = parseScaleEstimate(raw);
  if (!estimate) return null;
  if (estimate.verdict === "split-required") {
    return (
      <Badge
        className="h-5 shrink-0 gap-1 bg-amber-100 px-1.5 text-[11px] text-amber-800 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400"
        title={`规模估算: ${estimate.files} 文件${estimate.crossLifecycle ? " · 跨生命周期" : ""}`}
      >
        <IconAlertTriangle className="size-3" />
        规模 {estimate.files}
      </Badge>
    );
  }
  return (
    <span
      className="inline-block size-2 shrink-0 rounded-full bg-muted-foreground/40"
      title="规模估算: ok"
    />
  );
}

function sprintStatusVariant(
  status: string,
): "default" | "secondary" | "outline" {
  switch (status) {
    case "进行中":
      return "default";
    case "已完成":
    case "已发布":
      return "outline";
    case "规划":
    default:
      return "secondary";
  }
}

function sprintStatusColor(status: string): string {
  switch (status) {
    case "规划":
      return "bg-secondary text-secondary-foreground";
    case "进行中":
      return "bg-blue-500 text-white";
    case "已完成":
      return "bg-emerald-500 text-white";
    case "已发布":
      return "bg-emerald-600 text-white";
    default:
      return "bg-muted text-muted-foreground";
  }
}

const SPRINT_PHASE_LABEL: Record<string, string> = {
  planning: "规划",
  executing: "执行中",
  done: "已完成",
};
function sprintPhaseLabel(phase: string): string {
  return SPRINT_PHASE_LABEL[phase] ?? phase;
}
function sprintPhaseColor(phase: string): string {
  switch (phase) {
    case "planning":
      return "bg-secondary text-secondary-foreground";
    case "executing":
      return "bg-blue-500 text-white";
    case "done":
      return "bg-emerald-500 text-white";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function fmtDate(d: string): string {
  if (!d) return "—";
  return d.slice(0, 10);
}

function fmtDateTime(d: string): string {
  if (!d) return "—";
  return d.slice(0, 16).replace("T", " ");
}

function priorityLabel(p: number): string {
  switch (p) {
    case 1:
      return "P0";
    case 2:
      return "P1";
    case 3:
      return "P2";
    case 4:
      return "P3";
    default:
      return "P?";
  }
}

function priorityColor(p: number): string {
  switch (p) {
    case 1:
      return "bg-red-500 text-white";
    case 2:
      return "bg-orange-500 text-white";
    case 3:
      return "bg-amber-500 text-white";
    case 4:
      return "bg-blue-500 text-white";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function itemTypeColor(t: string): string {
  switch (t) {
    case "需求":
      return "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400";
    case "任务":
      return "bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-400";
    case "缺陷":
      return "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400";
    case "测试":
      return "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400";
    case "生产问题":
      return "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function stageColors(stageName: string): string {
  switch (stageName) {
    case "待办":
      return "bg-gray-300 dark:bg-gray-600";
    case "分析":
      return "bg-amber-400";
    case "设计":
      return "bg-yellow-400";
    case "实施":
      return "bg-blue-400";
    case "测试":
      return "bg-purple-400";
    case "验收":
      return "bg-indigo-400";
    case "交付":
      return "bg-emerald-400";
    default:
      return "bg-gray-300";
  }
}

function stageStatusLabel(status: string): { label: string; color: string } {
  switch (status) {
    case "待执行":
      return { label: "待执行", color: "text-gray-500" };
    case "执行中":
      return { label: "执行中", color: "text-blue-500" };
    case "已完成":
      return { label: "已完成", color: "text-emerald-500" };
    case "已驳回":
      return { label: "已驳回", color: "text-red-500" };
    case "跳过":
      return { label: "跳过", color: "text-gray-400" };
    default:
      return { label: status, color: "text-muted-foreground" };
  }
}

// ── Metadata row ─────────────────────────────────────────────────────────────

function MetaRow({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof IconGitBranch;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 px-3.5 py-2.5">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="w-20 shrink-0 pt-px text-xs text-muted-foreground">
        {label}
      </span>
      <div className="min-w-0 flex-1 text-sm">{children}</div>
    </div>
  );
}

// ── Delivery progress card ───────────────────────────────────────────────────

function DeliveryProgressCard({ items }: { items: TrackerWorkItem[] }) {
  const stageOrder = [
    "待办",
    "分析",
    "设计",
    "实施",
    "测试",
    "验收",
    "交付",
  ] as const;

  // Count items per currentStageName
  const stageCounts: Record<string, number> = {};
  for (const s of stageOrder) {
    stageCounts[s] = 0;
  }
  for (const item of items) {
    const stageName = item.currentStageName;
    if (stageName in stageCounts) {
      stageCounts[stageName] += 1;
    }
  }

  const totalItems = items.length;

  return (
    <div className="rounded-xl border bg-card p-5 shadow-sm">
      <h3 className="mb-4 text-sm font-semibold">交付进度</h3>
      <div className="space-y-3">
        {stageOrder.map((stageName) => {
          const count = stageCounts[stageName];
          const pct =
            totalItems > 0 ? Math.round((count / totalItems) * 100) : 0;
          return (
            <div key={stageName} className="flex items-center gap-3">
              <span className="w-12 shrink-0 text-xs font-medium text-muted-foreground">
                {stageName}
              </span>
              <Badge
                variant="secondary"
                className="h-5 px-1.5 text-[11px] font-mono"
              >
                {count}
              </Badge>
              <div className="flex-1 h-2 overflow-hidden rounded-full bg-secondary">
                <div
                  className={cn(
                    "h-full transition-all",
                    stageColors(stageName),
                  )}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="w-8 shrink-0 text-right text-[11px] text-muted-foreground">
                {pct}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Sprint items list card ───────────────────────────────────────────────────

function SprintItemsCard({
  sprint,
  items,
  stages,
}: {
  sprint: SprintDetail;
  items: TrackerWorkItem[];
  stages: Stage[];
}) {
  if (items.length === 0) {
    return (
      <div className="rounded-xl border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">本 Sprint 暂无工作项。</p>
        <Button asChild size="sm" className="mt-3 gap-1.5">
          <Link to="/items/new">
            <IconPlus className="size-4" />
            新建工作项
          </Link>
        </Button>
      </div>
    );
  }

  // Build a map of workItemId → current Stage (latest stage for each item)
  const stageMap = new Map<string, Stage>();
  for (const s of stages) {
    if (!stageMap.has(s.workItemId)) {
      stageMap.set(s.workItemId, s);
    }
  }

  return (
    <div className="rounded-xl border bg-card p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          本 Sprint 工作项 · {items.length}
        </h3>
        <Button asChild size="sm" variant="outline" className="gap-1.5">
          <Link to="/items/new">
            <IconPlus className="size-4" />
            新建工作项
          </Link>
        </Button>
      </div>

      <div className="divide-y divide-border">
        {items.map((item) => {
          const currentStage = stageMap.get(item.id);
          return (
            <div
              key={item.id}
              className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
            >
              {/* Item key — F8: itemKeyDisplay disambiguates historical
                  duplicate itemKeys within the same project (SDLC-032~036). */}
              <span
                className="w-16 shrink-0 font-mono text-[11px] font-medium text-muted-foreground"
                title={
                  item.itemKeyDisplay && item.itemKeyDisplay !== item.itemKey
                    ? "历史重号，已消歧显示"
                    : undefined
                }
              >
                {item.itemKeyDisplay ?? item.itemKey}
              </span>

              {/* Title (link) */}
              <Link
                to={`/items/${item.id}`}
                className="min-w-0 flex-1 truncate text-sm font-medium text-foreground hover:text-foreground hover:underline"
              >
                {item.title}
              </Link>

              {/* Type badge */}
              <Badge
                variant="outline"
                className={cn(
                  "h-5 px-1.5 text-[11px]",
                  itemTypeColor(item.type),
                )}
              >
                {item.type}
              </Badge>

              {/* Priority badge */}
              <Badge
                variant="outline"
                className={cn(
                  "h-5 px-1.5 text-[11px]",
                  priorityColor(item.priority),
                )}
              >
                {priorityLabel(item.priority)}
              </Badge>

              {/* F5: 规模徽标(Briefs 列表行) */}
              <ScaleBadgeCompact raw={item.scaleEstimate} />

              {/* Current stage · stageStatus */}
              {currentStage ? (
                <span className="flex shrink-0 items-center gap-1 text-xs">
                  <span className="font-medium text-foreground">
                    {currentStage.stageName}
                  </span>
                  <span
                    className={cn(
                      "text-muted-foreground",
                      stageStatusLabel(currentStage.stageStatus).color,
                    )}
                  >
                    · {stageStatusLabel(currentStage.stageStatus).label}
                  </span>
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">—</span>
              )}

              {/* Assignee avatar (small) */}
              <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
                {(item as { assigneeName?: string }).assigneeName
                  ? (item as { assigneeName?: string }).assigneeName![0]
                  : "?"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Sprint Artifacts Section ──────────────────────────────────────────────────
// ArtifactBadge and ArtifactViewDialog (agent/human tone + content dialog) now
// live in @/components/ArtifactBadge — shared with the per-work-item "产物"
// panel (ArtifactsPanel) and the Inbox "关联产物" card so every screen uses
// the same vocabulary instead of each defining their own copy.

function SprintArtifactsSection({ sprintId }: { sprintId: string }) {
  const { data, isLoading } = useSprintArtifacts(sprintId);
  const [selectedArtifact, setSelectedArtifact] =
    useState<SprintArtifact | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const byDocKey = data?.byDocKey ?? {};
  const docKeys = Object.keys(byDocKey);

  if (isLoading) {
    return (
      <div className="rounded-xl border bg-card p-5 shadow-sm">
        <h3 className="mb-4 text-sm font-semibold">产物</h3>
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (docKeys.length === 0) {
    return (
      <div className="rounded-xl border bg-card p-5 shadow-sm">
        <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold">
          <IconFileText className="size-4 text-muted-foreground" />
          产物
        </h3>
        <p className="text-sm text-muted-foreground">本 Sprint 暂无产物。</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card p-5 shadow-sm">
      <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold">
        <IconFileText className="size-4 text-muted-foreground" />
        产物 · {docKeys.length} 类
      </h3>
      <div className="space-y-4">
        {docKeys.map((docKey) => {
          const versions = byDocKey[docKey] ?? [];
          const latest = versions[versions.length - 1];
          if (!latest) return null;
          return (
            <div key={docKey} className="rounded-lg border p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="font-mono text-xs font-semibold text-foreground/80">
                  {docKey}
                </span>
                <span className="text-xs text-muted-foreground">
                  {latest.kind}
                </span>
                <span className="ml-auto text-[11px] text-muted-foreground">
                  共 {versions.length} 版
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {versions.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => {
                      setSelectedArtifact(a);
                      setDialogOpen(true);
                    }}
                    className={cn(
                      "flex items-center gap-1.5 rounded border px-2 py-1 text-xs transition-colors hover:bg-accent",
                      a.id === latest.id
                        ? "border-primary/50 bg-primary/5"
                        : "border-border bg-background",
                    )}
                  >
                    <ArtifactBadge kind={a.producedByKind} />
                    <span className="font-mono">v{a.version}</span>
                    <span className="max-w-[120px] truncate text-muted-foreground">
                      {a.name}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <ArtifactViewDialog
        artifact={selectedArtifact}
        open={dialogOpen}
        onClose={() => {
          setDialogOpen(false);
          setSelectedArtifact(null);
        }}
      />
    </div>
  );
}

// ── Sprint Approvals Section ──────────────────────────────────────────────────

function approvalStatusBadge(status: string) {
  switch (status) {
    case "pending":
      return (
        <Badge variant="secondary" className="bg-amber-400/20 text-amber-700">
          待审批
        </Badge>
      );
    case "approved":
      return (
        <Badge
          variant="secondary"
          className="bg-emerald-400/20 text-emerald-700"
        >
          已批准
        </Badge>
      );
    case "rejected":
      return <Badge variant="destructive">已拒绝</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function fmtApprovalTime(iso?: string | null): string {
  if (!iso) return "—";
  return iso.slice(0, 16).replace("T", " ");
}

function RequestApprovalDialog({
  sprintId,
  open,
  onClose,
}: {
  sprintId: string;
  open: boolean;
  onClose: () => void;
}) {
  const requestApproval = useRequestApproval();
  const [gateKey, setGateKey] = useState<string>("plan-signoff");
  const [workItemId, setWorkItemId] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    void requestApproval
      .mutateAsync({
        sprintId,
        gateKey: gateKey as GateKey,
        workItemId: workItemId.trim() || undefined,
      })
      .then(onClose);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>发起审批</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="gateKey">门类型</Label>
            <Select value={gateKey} onValueChange={setGateKey}>
              <SelectTrigger id="gateKey">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.entries(gateLabels) as [string, string][]).map(
                  ([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="workItemId">工作项 ID（可选）</Label>
            <Input
              id="workItemId"
              placeholder="留空则关联整个 Sprint"
              value={workItemId}
              onChange={(e) => setWorkItemId(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={requestApproval.isPending}>
              {requestApproval.isPending ? "发起中…" : "发起"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RejectDialog({
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
          <DialogTitle>拒绝原因</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="reason">原因（必填）</Label>
            <Input
              id="reason"
              placeholder="请填写拒绝原因"
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
              {rejectGate.isPending ? "提交中…" : "确认拒绝"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SprintApprovalsSection({ sprintId }: { sprintId: string }) {
  const { data, isLoading } = useApprovals({ sprintId });
  const approveGate = useApproveGate();
  const [requestOpen, setRequestOpen] = useState(false);
  const [rejectTarget, setRejectTarget] = useState<string | null>(null);

  const approvals: Approval[] = Array.isArray(data) ? data : [];
  const pending = approvals.filter((a) => a.status === "pending");
  const history = approvals.filter((a) => a.status !== "pending");

  return (
    <div className="rounded-xl border bg-card p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <IconShieldCheck className="size-4 text-muted-foreground" />
          审批
          {pending.length > 0 ? (
            <Badge
              variant="secondary"
              className="bg-amber-400/20 text-amber-700 ml-1"
            >
              {pending.length} 待审
            </Badge>
          ) : null}
        </h3>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={() => setRequestOpen(true)}
        >
          <IconPlus className="size-4" />
          发起审批
        </Button>
      </div>

      {isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : approvals.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          本 Sprint 暂无审批记录。
        </p>
      ) : (
        <div className="space-y-3">
          {/* Pending approvals */}
          {pending.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                待审批 · {pending.length}
              </p>
              {pending.map((a) => (
                <div
                  key={a.id}
                  className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50/50 p-3 dark:border-amber-900/30 dark:bg-amber-950/20 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">
                        {gateLabels[a.gateKey as GateKey] ?? a.gateKey}
                      </span>
                      {approvalStatusBadge(a.status)}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                      <span>发起人: {a.requestedBy}</span>
                      {a.workItemId ? (
                        <span>工作项: {a.workItemId}</span>
                      ) : null}
                      <span>{fmtApprovalTime(a.createdAt)}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      size="sm"
                      variant="default"
                      className="gap-1"
                      onClick={() => void approveGate.mutateAsync({ id: a.id })}
                      disabled={approveGate.isPending}
                    >
                      <IconCheck className="size-3.5" />
                      批准
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1 text-destructive hover:text-destructive"
                      onClick={() => setRejectTarget(a.id)}
                    >
                      <IconX className="size-3.5" />
                      拒绝
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {/* History */}
          {history.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                历史记录 · {history.length}
              </p>
              {history.map((a) => (
                <div
                  key={a.id}
                  className="flex flex-col gap-1 rounded-lg border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">
                        {gateLabels[a.gateKey as GateKey] ?? a.gateKey}
                      </span>
                      {approvalStatusBadge(a.status)}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                      <span>发起人: {a.requestedBy}</span>
                      {a.decidedBy ? <span>决策人: {a.decidedBy}</span> : null}
                      {a.reason ? <span>原因: {a.reason}</span> : null}
                      {a.decidedAt ? (
                        <span>决策时间: {fmtApprovalTime(a.decidedAt)}</span>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}

      <RequestApprovalDialog
        sprintId={sprintId}
        open={requestOpen}
        onClose={() => setRequestOpen(false)}
      />
      {rejectTarget ? (
        <RejectDialog
          approvalId={rejectTarget}
          open={!!rejectTarget}
          onClose={() => setRejectTarget(null)}
        />
      ) : null}
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────

export function SprintDetailPage() {
  const { id = "" } = useParams();
  const { data: rawSprint, isLoading } = useSprint(id);
  const sprint = rawSprint as SprintDetail | undefined;

  if (isLoading && !sprint) {
    return (
      <div className="mx-auto max-w-5xl space-y-5 p-6">
        <Skeleton className="h-7 w-24" />
        <Skeleton className="h-9 w-2/3" />
        <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
          <Skeleton className="h-48 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  if (!sprint) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <p className="text-sm text-muted-foreground">未找到该 Sprint。</p>
        <Button asChild variant="ghost" className="mt-3 gap-1.5">
          <Link to="/sprints">
            <IconArrowLeft className="size-4" /> 返回 Sprint 列表
          </Link>
        </Button>
      </div>
    );
  }

  const items = sprint.items ?? [];
  const stages = sprint.stages ?? [];

  return (
    <div className="mx-auto max-w-5xl p-5 sm:p-6">
      {/* Back link */}
      <Button asChild variant="ghost" size="sm" className="-ml-2 mb-3 gap-1.5">
        <Link to="/sprints">
          <IconArrowLeft className="size-4" /> Sprint 列表
        </Link>
      </Button>

      {/* ── Header ── */}
      <header className="mb-5">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Badge
            variant={sprintStatusVariant(sprint.status)}
            className={cn("px-2 text-[11px]", sprintStatusColor(sprint.status))}
          >
            {sprint.status}
          </Badge>
          <Badge
            className={cn(
              "px-2 text-[11px]",
              sprintPhaseColor(sprint.phase ?? "planning"),
            )}
          >
            {sprintPhaseLabel(sprint.phase ?? "planning")}
          </Badge>
        </div>

        <h1 className="text-2xl font-semibold leading-tight tracking-tight">
          {sprint.name}
        </h1>

        {sprint.goal ? (
          <p className="mt-2 text-sm text-muted-foreground">{sprint.goal}</p>
        ) : null}

        {/* Meta info */}
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sprint.branch ? (
            <div className="flex items-center gap-2 text-sm">
              <IconGitBranch className="size-4 text-muted-foreground" />
              <span className="font-mono text-xs text-foreground/80">
                {sprint.branch}
              </span>
            </div>
          ) : null}
          {sprint.startDate || sprint.endDate ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <IconCalendar className="size-3.5" />
              <span className="text-xs">{fmtDate(sprint.startDate)}</span>
              {sprint.startDate && sprint.endDate ? (
                <span className="text-muted-foreground/50">→</span>
              ) : null}
              <span className="text-xs">{fmtDate(sprint.endDate)}</span>
            </div>
          ) : null}
        </div>
      </header>

      {/* ── Body ── */}
      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        {/* Left column: progress + items + artifacts + approvals */}
        <div className="order-2 min-w-0 space-y-5 lg:order-1">
          <DeliveryProgressCard items={items} />
          <SprintItemsCard sprint={sprint} items={items} stages={stages} />
          <SprintArtifactsSection sprintId={id} />
          <SprintApprovalsSection sprintId={id} />
        </div>

        {/* Right column: meta */}
        <aside className="order-1 lg:order-2">
          <div className="divide-y divide-border rounded-xl border border-border bg-card lg:sticky lg:top-4">
            <MetaRow icon={IconGitBranch} label="分支">
              <span className="font-mono text-xs text-foreground/80">
                {sprint.branch ?? "未配置"}
              </span>
            </MetaRow>

            <MetaRow icon={IconCalendar} label="开始日期">
              <span className="text-xs text-muted-foreground">
                {fmtDate(sprint.startDate)}
              </span>
            </MetaRow>

            <MetaRow icon={IconClock} label="结束日期">
              <span className="text-xs text-muted-foreground">
                {fmtDate(sprint.endDate)}
              </span>
            </MetaRow>

            <MetaRow icon={IconPackage} label="工作项">
              <span className="text-xs text-muted-foreground">
                {items.length} 项
              </span>
            </MetaRow>

            <MetaRow icon={IconClock} label="创建时间">
              <span className="text-xs text-muted-foreground">
                {fmtDateTime(sprint.createdAt)}
              </span>
            </MetaRow>
          </div>
        </aside>
      </div>
    </div>
  );
}
