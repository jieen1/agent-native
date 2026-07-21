import type {
  Approval,
  GateKey,
  ScaleEstimate,
  SprintDetail,
  SprintArtifact,
  SprintPhase,
  TrackerWorkItem,
} from "@shared/types";
import {
  GATE_KEY_LABELS as gateLabels,
  SPRINT_PHASE_LABELS,
  SPRINT_PHASE_ORDER,
} from "@shared/types";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconBrain,
  IconCalendar,
  IconCheck,
  IconClipboardList,
  IconExternalLink,
  IconFileText,
  IconGitBranch,
  IconHandStop,
  IconPlayerPlay,
  IconPlayerTrackNext,
  IconPlus,
  IconRocket,
  IconRubberStamp,
  IconStopwatch,
  IconTrendingDown,
  IconX,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { Link } from "react-router";

import { formatDurationSec } from "@shared/sprint-timing";
import { ActorAvatar } from "@/components/ActorAvatar";
import { ArtifactBadge, ArtifactViewDialog } from "@/components/ArtifactBadge";
import { InspectorSection } from "@/components/InspectorSection";
import { PriorityBars } from "@/components/PriorityBars";
import { RunBadgeCompact } from "@/components/RunEvidenceList";
import { SprintPhaseStepper } from "@/components/SprintPhaseStepper";
import { StatusIcon } from "@/components/StatusIcon";
import { StatusRing } from "@/components/StatusRing";
import { orchestratorBrainHref } from "@/components/tracker-format";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useApprovals,
  useApproveGate,
  useGoalMetrics,
  useQueueHealth,
  useRejectGate,
  useReleaseSprint,
  useRequestApproval,
  useSprint,
  useSprintArtifacts,
  useSprintBurndown,
  useSprintStageTiming,
  useUpdateSprint,
} from "@/hooks/use-tracker";
import { classifyDocKey, ARTIFACT_GROUP_ORDER } from "@/lib/sprint-artifacts";
import {
  computeBurndown,
  medianStageDurationsMinutes,
} from "@/lib/sprint-metrics";
import { cn } from "@/lib/utils";

// ── Helpers ──────────────────────────────────────────────────────────────────

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
  return null;
}

function sprintStatusColor(status: string): string {
  switch (status) {
    case "进行中":
      return "bg-blue-500 text-white";
    case "已完成":
      return "bg-emerald-500 text-white";
    case "已发布":
      return "bg-emerald-600 text-white";
    case "规划":
    default:
      return "bg-secondary text-secondary-foreground";
  }
}

// Phase header badge tone — a coarse mapping over the 8 real phases, not a
// fabricated gate-criteria fraction. Text is the raw phase label (matches the
// prototype's plain-English badge, e.g. `<span class="badge b-info">executing</span>`).
const PHASE_TONE: Record<SprintPhase, string> = {
  planning: "bg-secondary text-secondary-foreground",
  designing: "bg-secondary text-secondary-foreground",
  executing: "bg-info text-white",
  verifying: "bg-info text-white",
  auditing: "bg-warning text-white",
  promoting: "bg-info text-white",
  storytelling: "bg-agent text-white",
  done: "bg-success text-white",
};
function phaseTone(phase: string): string {
  return PHASE_TONE[phase as SprintPhase] ?? "bg-muted text-muted-foreground";
}

function fmtDate(d: string): string {
  if (!d) return "—";
  return d.slice(0, 10);
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

function elapsedSince(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
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

// ── Metadata row (Inspector) ─────────────────────────────────────────────────

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
      <span className="w-16 shrink-0 pt-px text-xs text-muted-foreground">
        {label}
      </span>
      <div className="min-w-0 flex-1 text-sm">{children}</div>
    </div>
  );
}

// ── Delivery progress card (kept — real, generic fallback for every phase,
// not just executing) ────────────────────────────────────────────────────────

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
  if (totalItems === 0) return null;

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

// ── ① executing 相位面板 (miniboard: 排队/运行中/已完成, real per-item
// grouping — no fabricated git log / no fabricated dependency reason) ───────

function MiniCard({ item }: { item: TrackerWorkItem }) {
  const isRunning = item.status === "running" || item.status === "dispatched";
  const isBlocked = item.status === "blocked";
  const isMerged =
    item.status === "done" ||
    item.status === "closed" ||
    item.currentStageName === "交付";
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-background p-2.5 text-xs">
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[11px] text-muted-foreground">
          {item.itemKeyDisplay ?? item.itemKey}
        </span>
        <PriorityBars priority={item.priority} />
      </div>
      <Link
        to={`/items/${item.id}`}
        className="truncate font-medium text-foreground hover:underline"
      >
        {item.title}
      </Link>
      {isBlocked ? (
        <Badge className="w-fit gap-1 bg-warning/15 px-1.5 text-[10.5px] text-warning hover:bg-warning/15">
          <IconHandStop className="size-3" />
          等待人工确认
        </Badge>
      ) : isRunning ? (
        <span className="flex items-center gap-1.5 text-[11px] text-info">
          <StatusRing status="running" size={10} />
          执行中
          {item.dispatchedAt ? (
            <span className="font-mono text-muted-foreground">
              {elapsedSince(item.dispatchedAt)}
            </span>
          ) : null}
        </span>
      ) : isMerged ? (
        <span className="flex items-center gap-1.5">
          <Badge className="gap-1 bg-success/15 px-1.5 text-[10.5px] text-success hover:bg-success/15">
            <IconCheck className="size-3" />
            已完成
          </Badge>
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
        </span>
      ) : (
        <span className="text-[11px] text-muted-foreground">排队中</span>
      )}
    </div>
  );
}

function ExecutingPhasePanel({ items }: { items: TrackerWorkItem[] }) {
  const queued: TrackerWorkItem[] = [];
  const running: TrackerWorkItem[] = [];
  const merged: TrackerWorkItem[] = [];
  for (const item of items) {
    if (item.status === "running" || item.status === "dispatched") {
      running.push(item);
    } else if (item.status === "queued" || item.status === "blocked") {
      queued.push(item);
    } else if (
      item.status === "done" ||
      item.status === "closed" ||
      item.currentStageName === "交付"
    ) {
      merged.push(item);
    }
  }

  if (queued.length === 0 && running.length === 0 && merged.length === 0) {
    return (
      <div className="rounded-xl border bg-card p-5 shadow-sm">
        <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
          <IconPlayerPlay className="size-4 text-info" />
          实施进行中
        </div>
        <p className="text-sm text-muted-foreground">
          暂无正在排队、执行或已完成的工作项。
        </p>
      </div>
    );
  }

  const columns: [string, TrackerWorkItem[], React.ReactNode][] = [
    ["排队", queued, <StatusRing key="q" status="queued" size={10} />],
    ["运行中", running, <StatusRing key="r" status="running" size={10} />],
    ["已合入", merged, <StatusIcon key="m" tone="ok" size="sm" />],
  ];

  return (
    <div className="rounded-xl border bg-card p-5 shadow-sm">
      <div className="mb-4 flex items-center gap-2 text-sm font-semibold">
        <IconPlayerPlay className="size-4 text-info" />
        实施进行中
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {columns.map(([label, list, ring]) => (
          <div key={label} className="flex min-w-0 flex-col gap-2">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
              {ring}
              {label}
              <span className="font-mono">{list.length}</span>
            </div>
            {list.length === 0 ? (
              <p className="text-[11px] text-muted-foreground/70">—</p>
            ) : (
              list.map((item) => <MiniCard key={item.id} item={item} />)
            )}
          </div>
        ))}
      </div>
      <p className="mt-4 text-[10.5px] text-muted-foreground">
        「实时合入流」（sprint 分支 git 提交时间线）需要真实 git log
        数据源，当前无此读取通道，本次范围外未实现。
      </p>
    </div>
  );
}

// ── ② 工作项表 (Key/标题/阶段/运行信号/PR·运行) ──────────────────────────────

function StageRing({ status }: { status: string }) {
  switch (status) {
    case "running":
    case "dispatched":
      return <StatusRing status="running" size={12} />;
    case "queued":
      return <StatusRing status="queued" size={12} />;
    case "blocked":
      return <StatusRing status="gate" size={12} />;
    case "failed":
      return <StatusIcon tone="err" size="sm" />;
    case "done":
    case "closed":
      return <StatusIcon tone="ok" size="sm" />;
    default:
      return <StatusRing status="pending" size={12} />;
  }
}

function RunSignalCell({ item }: { item: TrackerWorkItem }) {
  if (item.status === "running" || item.status === "dispatched") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11.5px] text-info">
        <StatusRing status="running" size={11} />
        执行中
        {item.dispatchedAt ? (
          <span className="font-mono text-muted-foreground">
            {elapsedSince(item.dispatchedAt)}
          </span>
        ) : null}
      </span>
    );
  }
  if (item.status === "queued") {
    return (
      <Badge className="h-5 gap-1 bg-warning/15 px-1.5 text-[10.5px] text-warning hover:bg-warning/15">
        排队中
      </Badge>
    );
  }
  if (item.status === "blocked") {
    return (
      <Badge className="h-5 gap-1 bg-warning/15 px-1.5 text-[10.5px] text-warning hover:bg-warning/15">
        <IconHandStop className="size-3" />
        等待人工确认
      </Badge>
    );
  }
  if (item.status === "failed") {
    return (
      <Badge className="h-5 gap-1 bg-destructive/15 px-1.5 text-[10.5px] text-destructive hover:bg-destructive/15">
        <IconX className="size-3" />
        失败
      </Badge>
    );
  }
  if (item.status === "done" || item.status === "closed") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11.5px] text-success">
        <StatusIcon tone="ok" size="sm" />
        已完成
      </span>
    );
  }
  if (item.status === "returned") {
    return (
      <Badge className="h-5 gap-1 bg-agent/15 px-1.5 text-[10.5px] text-agent hover:bg-agent/15">
        待人工评审
      </Badge>
    );
  }
  return <span className="text-xs text-muted-foreground">—</span>;
}

/** "PR" column — the tracker never persists a real PR number for a work
 *  item (only get-activity's per-item transcript parse does, and polling
 *  that for every row here would be an N+1 waterfall — see BoardPage's
 *  RunSignalLine, which makes the same trade-off). Links to the bound
 *  orchestrator run instead of showing a fabricated PR number. */
function RunLinkCell({ item }: { item: TrackerWorkItem }) {
  if (!item.orchestratorRunId) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  return (
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
  );
}

function SprintItemsTable({ items }: { items: TrackerWorkItem[] }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <IconClipboardList className="size-4 text-muted-foreground" />
          工作项
          <span className="font-mono font-normal text-muted-foreground">
            {items.length}
          </span>
        </div>
        <Button asChild size="sm" variant="outline" className="gap-1.5">
          <Link to="/items/new">
            <IconPlus className="size-4" />
            新建工作项
          </Link>
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="rounded-xl border bg-card p-8 text-center">
          <p className="text-sm text-muted-foreground">
            本 Sprint 暂无工作项。
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-9 px-3 text-[10.5px]">Key</TableHead>
                <TableHead className="h-9 px-3 text-[10.5px]">标题</TableHead>
                <TableHead className="h-9 px-3 text-[10.5px]">阶段</TableHead>
                <TableHead className="h-9 px-3 text-[10.5px]">
                  运行信号
                </TableHead>
                <TableHead className="h-9 px-3 text-[10.5px]">
                  PR / 运行
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="px-3 py-2 font-mono text-[11.5px] text-muted-foreground">
                    {item.itemKeyDisplay ?? item.itemKey}
                  </TableCell>
                  <TableCell className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Link
                        to={`/items/${item.id}`}
                        className="min-w-0 truncate font-medium text-foreground hover:underline"
                      >
                        {item.title}
                      </Link>
                      <Badge
                        variant="outline"
                        className={cn(
                          "h-5 shrink-0 px-1.5 text-[10.5px]",
                          itemTypeColor(item.type),
                        )}
                      >
                        {item.type}
                      </Badge>
                      <ScaleBadgeCompact raw={item.scaleEstimate} />
                    </div>
                  </TableCell>
                  <TableCell className="px-3 py-2">
                    <span className="inline-flex items-center gap-1.5 text-xs">
                      <StageRing status={item.status} />
                      {item.currentStageName}
                    </span>
                  </TableCell>
                  <TableCell className="px-3 py-2">
                    <RunSignalCell item={item} />
                  </TableCell>
                  <TableCell className="px-3 py-2">
                    <RunLinkCell item={item} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

// ── ③ 产物库 (规划/设计/验证/其他 三段式分组) ────────────────────────────────

function SprintArtifactsSection({ sprintId }: { sprintId: string }) {
  const { data, isLoading } = useSprintArtifacts(sprintId);
  const [selectedArtifact, setSelectedArtifact] =
    useState<SprintArtifact | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const byDocKey = data?.byDocKey ?? {};
  const docKeys = Object.keys(byDocKey);

  const grouped = useMemo(() => {
    const groups: Record<string, string[]> = {};
    for (const key of docKeys) {
      const group = classifyDocKey(key);
      (groups[group] ??= []).push(key);
    }
    return groups;
  }, [docKeys]);

  if (isLoading) {
    return (
      <div className="rounded-xl border bg-card p-5 shadow-sm">
        <h3 className="mb-4 text-sm font-semibold">产物库</h3>
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  return (
    <section>
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <IconFileText className="size-4 text-muted-foreground" />
        产物库
        <span className="font-mono font-normal text-muted-foreground">
          {docKeys.length}
        </span>
      </div>
      <div className="rounded-xl border bg-card p-5 shadow-sm">
        {docKeys.length === 0 ? (
          <p className="text-sm text-muted-foreground">本 Sprint 暂无产物。</p>
        ) : (
          <div className="flex flex-col gap-4">
            {ARTIFACT_GROUP_ORDER.filter((g) => grouped[g]?.length).map(
              (group) => (
                <div key={group}>
                  <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {group}
                  </div>
                  <div className="flex flex-col gap-1">
                    {grouped[group]!.map((docKey) => {
                      const versions = byDocKey[docKey] ?? [];
                      const latest = versions[versions.length - 1];
                      if (!latest) return null;
                      return (
                        <div
                          key={docKey}
                          className="flex flex-wrap items-center gap-2 border-b border-border/60 py-1.5 text-[12.5px] last:border-0"
                        >
                          <span className="font-medium">{docKey}</span>
                          <Badge
                            variant="secondary"
                            className="h-5 px-1.5 font-mono text-[10.5px]"
                          >
                            共 {versions.length} 版
                          </Badge>
                          <ArtifactBadge kind={latest.producedByKind} />
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedArtifact(latest);
                              setDialogOpen(true);
                            }}
                            className="ml-auto text-[11.5px] text-muted-foreground hover:text-foreground hover:underline"
                          >
                            agent 视图
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ),
            )}
          </div>
        )}
      </div>
      <ArtifactViewDialog
        artifact={selectedArtifact}
        open={dialogOpen}
        onClose={() => {
          setDialogOpen(false);
          setSelectedArtifact(null);
        }}
      />
    </section>
  );
}

// ── ④ 审批记录 (kept — real, interactive; SprintApprovalsSection未改变行为，
// 仅标题/图标向原型靠拢) ──────────────────────────────────────────────────────

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
    <section>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <IconRubberStamp className="size-4 text-muted-foreground" />
          审批记录
          {pending.length > 0 ? (
            <Badge
              variant="secondary"
              className="ml-1 bg-amber-400/20 text-amber-700"
            >
              {pending.length} 待审
            </Badge>
          ) : null}
        </div>
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

      <div className="rounded-xl border bg-card p-5 shadow-sm">
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : approvals.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            本 Sprint 暂无审批记录。
          </p>
        ) : (
          <div className="space-y-3">
            {pending.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
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
                        onClick={() =>
                          void approveGate.mutateAsync({ id: a.id })
                        }
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

            {history.length > 0 ? (
              <div className="space-y-1.5">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
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
                        {a.decidedBy ? (
                          <span>决策人: {a.decidedBy}</span>
                        ) : null}
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
      </div>

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
    </section>
  );
}

// ── Right column: Goal card ─────────────────────────────────────────────────

function GoalCard({ sprintId, goal }: { sprintId: string; goal: string }) {
  const { data, isLoading, error } = useGoalMetrics(sprintId);

  return (
    <InspectorSection label="Goal · 完成判据的锚" first>
      <div className="px-3.5 pb-3">
        <p className="mb-2 text-[12.5px] font-medium leading-snug">
          {goal || "（未填写 Sprint 目标）"}
        </p>

        {isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : error ? (
          <p className="text-[11.5px] text-muted-foreground">
            未设置目标指标 — 尚未创建 sprint-doc
            产物，无法提取目标指标。在规划工作台产出 sprint-doc 并补充「##
            Success Metrics」章节后自动识别。
          </p>
        ) : !data || data.metrics.length === 0 ? (
          <p className="text-[11.5px] text-muted-foreground">
            未设置目标指标 — sprint-doc 尚未包含「## Success
            Metrics」章节（格式：
            <code className="mx-1 rounded bg-muted px-1 font-mono text-[10.5px]">
              - M1 | Leading | 陈述 | 证据来源
            </code>
            ），补充后自动识别，不编造。
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              {data.metrics.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center gap-1.5 text-[11.5px]"
                >
                  <StatusRing status="pending" size={11} />
                  <span className="font-mono text-muted-foreground">
                    {m.id}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{m.statement}</span>
                  <span className="shrink-0 text-muted-foreground">
                    待 gap-analysis
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[10.5px] text-muted-foreground">
              指标从 sprint-doc「Success Metrics」章节解析；MET/PARTIAL/UNMET
              判定由 gap-analysis（目标审计相位）回填，该机制本次未实现，故均
              显示「待 gap-analysis」——sprint 完成由 Goal 判定，不由单子关完
              判定。
            </p>
          </>
        )}
      </div>
    </InspectorSection>
  );
}

// ── Right column: 签核迷你卡 (real approvals data, read-only summary) ───────

const MINI_GATE_KEYS: GateKey[] = [
  "plan-signoff",
  "ui-signoff",
  "design-signoff",
];

function GateMiniList({ sprintId }: { sprintId: string }) {
  const { data, isLoading } = useApprovals({ sprintId });
  const approvals: Approval[] = Array.isArray(data) ? data : [];

  if (isLoading) {
    return (
      <div className="px-3.5 py-2">
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {MINI_GATE_KEYS.map((key) => {
        const latest = approvals.find(
          (a) => a.gateKey === key && !a.workItemId,
        );
        return (
          <div
            key={key}
            className="flex items-center gap-2 px-3.5 py-1.5 text-[12.5px]"
          >
            {!latest ? (
              <StatusRing status="pending" size={12} />
            ) : latest.status === "approved" ? (
              <StatusIcon tone="ok" size="sm" />
            ) : latest.status === "rejected" ? (
              <StatusIcon tone="err" size="sm" />
            ) : (
              <StatusRing status="gate" size={12} />
            )}
            {gateLabels[key]}
            <span className="ml-auto font-mono text-[11px] text-muted-foreground">
              {latest?.decidedAt
                ? latest.decidedAt.slice(5, 10)
                : latest
                  ? "待审批"
                  : "未发起"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Right column: 健康门 (real cross-app orchestrator signal, reuses
// get-queue-health — same channel /queue's health bar already uses) ────────

function HealthRow({
  tone,
  label,
  detail,
}: {
  tone: "ok" | "warn" | "err";
  label: string;
  detail: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-2 px-3.5 py-1.5 text-[12.5px]">
          <StatusIcon tone={tone} size="sm" aria-label={label} />
          {label}
          <span className="ml-auto truncate text-[11px] text-muted-foreground">
            {detail}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="left">{detail}</TooltipContent>
    </Tooltip>
  );
}

function HealthGateMini() {
  const { data: health } = useQueueHealth();

  if (!health) {
    return (
      <div className="px-3.5 py-2">
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (!health.orchestratorReachable) {
    return (
      <p className="px-3.5 py-2 text-[11.5px] text-destructive">
        编排器不可达（{health.orchestratorError ?? "连接失败"}）——健康门状态
        暂不可读，出于诚实原则不展示伪造的健康态。
      </p>
    );
  }

  const vllmOk = !!health.devEngine?.configured;
  const ccOk = !!health.claudeCode?.loggedIn && !health.claudeCode.expired;
  const brainOk = !!health.brain?.driverAlive;

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex flex-col">
        <HealthRow
          tone={vllmOk ? "ok" : "warn"}
          label="vLLM"
          detail={
            vllmOk
              ? `已配置：${health.devEngine?.model ?? "?"}`
              : "未配置开发引擎"
          }
        />
        <HealthRow
          tone={ccOk ? "ok" : "err"}
          label="Claude Code"
          detail={
            health.claudeCode == null
              ? "未知"
              : health.claudeCode.expired
                ? "登录已过期"
                : health.claudeCode.loggedIn
                  ? "已登录"
                  : "未登录"
          }
        />
        <HealthRow
          tone={brainOk ? "ok" : "err"}
          label="Brain 槽"
          detail={
            health.brain == null
              ? "未知"
              : `${health.brain.running} / ${health.brain.concurrency ?? "?"}`
          }
        />
      </div>
    </TooltipProvider>
  );
}

// ── Right column: 度量摘要 (real burndown + median stage duration, honest
// empty state when there isn't enough real history) ────────────────────────

function MetricsSummary({ sprint }: { sprint: SprintDetail }) {
  const burndown = useMemo(
    () => computeBurndown(sprint.items, sprint.stages, sprint.startDate),
    [sprint.items, sprint.stages, sprint.startDate],
  );
  const durations = useMemo(
    () => medianStageDurationsMinutes(sprint.stages),
    [sprint.stages],
  );

  const svgWidth = 260;
  const svgHeight = 56;
  const points = burndown?.points ?? [];
  const lastPoint = points[points.length - 1];
  const maxRemaining = burndown ? Math.max(1, burndown.total) : 1;
  const polyline = points
    .map((p, i) => {
      const x = points.length > 1 ? (i / (points.length - 1)) * svgWidth : 0;
      const y = svgHeight - (p.remaining / maxRemaining) * svgHeight;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <div className="px-3.5 pb-3">
      {burndown ? (
        <>
          <svg
            viewBox={`0 0 ${svgWidth} ${svgHeight}`}
            className="h-14 w-full"
            role="img"
            aria-label={`燃尽：剩 ${lastPoint?.remaining ?? 0}/${burndown.total}`}
          >
            <polyline
              points={polyline}
              fill="none"
              className="stroke-info"
              strokeWidth={2}
            />
          </svg>
          <div className="mt-1 flex justify-between font-mono text-[10.5px] text-muted-foreground">
            <span>
              燃尽 · 剩 {lastPoint?.remaining ?? 0}/{burndown.total}
            </span>
            <span>{sprint.startDate.slice(5, 10)} 至今</span>
          </div>
        </>
      ) : (
        <p className="text-[11.5px] text-muted-foreground">
          暂无足够真实数据绘制燃尽趋势（需要 Sprint 起始日期与至少一天跨度）。
        </p>
      )}

      <div className="my-2.5 h-px bg-border" />

      <div className="text-[11.5px] text-muted-foreground">中位环节耗时</div>
      {durations.length === 0 ? (
        <p className="mt-1 text-[11.5px] text-muted-foreground">
          暂无耗时数据（尚无已完成阶段记录）。
        </p>
      ) : (
        <p className="mt-0.5 font-mono text-[11.5px]">
          {durations.map((d) => `${d.stageName} ${d.minutes}m`).join(" · ")}
        </p>
      )}
    </div>
  );
}

// ── M5 度量复盘: Sprint burndown chart ────────────────────────────────────────
// Work items remaining per day, derived from real stage completedAt + item
// status. Renders an SVG line chart with an ideal burn-down reference line.
// Shows "暂无数据" when the sprint has no startDate or is too new to plot.

function SprintBurndownChart({ sprintId }: { sprintId: string }) {
  const { data, isLoading } = useSprintBurndown(sprintId);

  const svgW = 560;
  const svgH = 160;
  const padL = 32;
  const padR = 8;
  const padT = 8;
  const padB = 24;
  const innerW = svgW - padL - padR;
  const innerH = svgH - padT - padB;

  const series = data?.series ?? [];
  const totalItems = data?.totalItems ?? 0;
  const hasData = series.length >= 2;

  const maxRemaining = hasData ? Math.max(1, totalItems) : 1;
  const n = series.length;

  function toX(i: number) {
    return padL + (n > 1 ? (i / (n - 1)) * innerW : 0);
  }
  function toY(remaining: number) {
    return padT + innerH - (remaining / maxRemaining) * innerH;
  }

  const actualPoints = series
    .map((p, i) => `${toX(i).toFixed(1)},${toY(p.remaining).toFixed(1)}`)
    .join(" ");

  // Ideal: straight line from totalItems at day 0 to 0 at last day.
  const idealPoints = hasData
    ? `${toX(0).toFixed(1)},${toY(totalItems).toFixed(1)} ${toX(n - 1).toFixed(1)},${toY(0).toFixed(1)}`
    : "";

  // X-axis: show first and last date labels.
  const firstDate = series[0]?.date ?? "";
  const lastDate = series[n - 1]?.date ?? "";
  const lastRemaining = series[n - 1]?.remaining ?? 0;

  return (
    <section>
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <IconTrendingDown className="size-4 text-muted-foreground" />
        燃尽图
        <span className="text-[11px] font-normal text-muted-foreground">
          （来源：tracker 阶段完成时间戳）
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card">
        {isLoading ? (
          <div className="p-5">
            <Skeleton className="h-40 w-full" />
          </div>
        ) : !hasData ? (
          <p className="p-5 text-sm text-muted-foreground">
            暂无数据（需要 Sprint 起始日期且至少跨越 2 天）。
          </p>
        ) : (
          <div className="p-4">
            <svg
              viewBox={`0 0 ${svgW} ${svgH}`}
              className="w-full"
              style={{ height: svgH }}
              role="img"
              aria-label={`燃尽图：剩 ${lastRemaining}/${totalItems} 工作项`}
            >
              {/* Y-axis gridlines at 0%, 50%, 100% */}
              {[0, 0.5, 1].map((frac) => {
                const y = padT + innerH * (1 - frac);
                const val = Math.round(maxRemaining * frac);
                return (
                  <g key={frac}>
                    <line
                      x1={padL}
                      y1={y}
                      x2={padL + innerW}
                      y2={y}
                      className="stroke-border"
                      strokeWidth={1}
                      strokeDasharray="4 3"
                    />
                    <text
                      x={padL - 4}
                      y={y + 4}
                      textAnchor="end"
                      className="fill-muted-foreground"
                      fontSize={10}
                    >
                      {val}
                    </text>
                  </g>
                );
              })}

              {/* Ideal burn-down (dashed) */}
              <polyline
                points={idealPoints}
                fill="none"
                className="stroke-muted-foreground"
                strokeWidth={1.5}
                strokeDasharray="5 4"
                opacity={0.5}
              />

              {/* Actual burn-down */}
              <polyline
                points={actualPoints}
                fill="none"
                className="stroke-info"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />

              {/* X-axis date labels */}
              <text
                x={toX(0)}
                y={svgH - 6}
                textAnchor="start"
                className="fill-muted-foreground"
                fontSize={10}
              >
                {firstDate}
              </text>
              <text
                x={toX(n - 1)}
                y={svgH - 6}
                textAnchor="end"
                className="fill-muted-foreground"
                fontSize={10}
              >
                {lastDate}
              </text>
            </svg>

            <div className="mt-1 flex items-center gap-4 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-0.5 w-6 bg-info" />
                实际
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-0.5 w-6 border-t border-dashed border-muted-foreground opacity-50" />
                理想
              </span>
              <span className="ml-auto font-mono">
                剩 {lastRemaining}/{totalItems}
              </span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

// ── M5 Sprint-status: per-work-item stage timing from real v3_spawns ─────────
// Every number here is derived from real orchestrator v3_spawns.started_at /
// completed_at timestamps via get-sprint-stage-timing. A stage with no spawn
// data shows "无数据" — never 0, never fabricated.

function StageTimingCell({ sec }: { sec: number | null }) {
  return (
    <span
      className={
        sec == null
          ? "text-muted-foreground"
          : "font-mono text-foreground tabular-nums"
      }
    >
      {formatDurationSec(sec)}
    </span>
  );
}

function SprintStageTiming({ sprintId }: { sprintId: string }) {
  const { data, isLoading } = useSprintStageTiming(sprintId);

  return (
    <section>
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <IconStopwatch className="size-4 text-muted-foreground" />
        阶段耗时
        <span className="text-[11px] font-normal text-muted-foreground">
          （来源：orchestrator v3_spawns 真实时间戳）
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card">
        {isLoading ? (
          <div className="p-5">
            <Skeleton className="h-24 w-full" />
          </div>
        ) : !data || data.items.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">
            暂无工作项或 orchestrator 数据（尚未派发任何工作项，v3_spawns 无记录）。
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-9 px-3 text-[10.5px]">Key</TableHead>
                <TableHead className="h-9 px-3 text-[10.5px]">标题</TableHead>
                <TableHead className="h-9 px-3 text-[10.5px] text-right">
                  dev
                </TableHead>
                <TableHead className="h-9 px-3 text-[10.5px] text-right">
                  qa
                </TableHead>
                <TableHead className="h-9 px-3 text-[10.5px] text-right">
                  review
                </TableHead>
                <TableHead className="h-9 px-3 text-[10.5px] text-right">
                  gate
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((item) => {
                const stageMap = Object.fromEntries(
                  item.stages.map((s) => [s.stage, s]),
                );
                return (
                  <TableRow key={item.workItemId}>
                    <TableCell className="px-3 py-2 font-mono text-[11.5px] text-muted-foreground">
                      {item.itemKey}
                    </TableCell>
                    <TableCell className="px-3 py-2">
                      <Link
                        to={`/items/${item.workItemId}`}
                        className="truncate font-medium text-foreground hover:underline"
                      >
                        {item.title}
                      </Link>
                    </TableCell>
                    {(["dev", "qa", "review", "gate"] as const).map((stage) => (
                      <TableCell
                        key={stage}
                        className="px-3 py-2 text-right text-xs"
                      >
                        <TooltipProvider delayDuration={100}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="cursor-default">
                                <StageTimingCell
                                  sec={stageMap[stage]?.totalSec ?? null}
                                />
                              </span>
                            </TooltipTrigger>
                            {stageMap[stage]?.spawns?.length ? (
                              <TooltipContent
                                side="left"
                                className="max-w-xs text-[11px]"
                              >
                                <p className="mb-1 font-semibold">
                                  {stageMap[stage]!.spawnCount} spawn(s)
                                </p>
                                {stageMap[stage]!.spawns.map((sp) => (
                                  <div key={sp.spawnId} className="font-mono">
                                    {sp.spawnId.slice(0, 8)}…{" "}
                                    {sp.startedAt?.slice(11, 19) ?? "?"}→
                                    {sp.completedAt?.slice(11, 19) ?? "运行中"}
                                    {sp.durationSec != null
                                      ? ` (${sp.durationSec}s)`
                                      : ""}
                                  </div>
                                ))}
                              </TooltipContent>
                            ) : null}
                          </Tooltip>
                        </TooltipProvider>
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {data?.errors && Object.keys(data.errors).length > 0 ? (
          <p className="border-t px-4 py-2 text-[11.5px] text-warning">
            部分 orchestrator 数据读取失败（不影响已有数据展示）：
            {Object.values(data.errors).join("; ")}
          </p>
        ) : null}
      </div>
    </section>
  );
}

// ── Release button (M5 §5 — Sprint '发布') ────────────────────────────────────
// Enabled only when sprint is in "已完成" status. Clicking transitions to
// "已发布". The action itself is idempotent: re-releasing an already-released
// sprint is a no-op (guarded server-side in release-sprint.ts).

function ReleaseButton({
  sprintId,
  status,
}: {
  sprintId: string;
  status: string;
}) {
  const releaseSprint = useReleaseSprint();
  const [open, setOpen] = useState(false);

  const isReleased = status === "已发布";
  const canRelease = status === "已完成" || isReleased;

  if (!canRelease) return null;

  return (
    <>
      <Button
        size="sm"
        variant={isReleased ? "outline" : "default"}
        className="gap-1.5"
        disabled={isReleased || releaseSprint.isPending}
        onClick={() => setOpen(true)}
      >
        <IconRocket className="size-4" />
        {isReleased ? "已发布" : "发布"}
      </Button>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>发布 Sprint？</AlertDialogTitle>
            <AlertDialogDescription>
              将 Sprint 状态标记为「已发布」，并写入 changelog 发布记录。
              此操作在已发布时为空操作（幂等），可安全重试。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void releaseSprint
                  .mutateAsync({ sprintId })
                  .then(() => setOpen(false));
              }}
              disabled={releaseSprint.isPending}
            >
              {releaseSprint.isPending ? "发布中…" : "确认发布"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ── 推进相位 (manual, unguarded — the criteria engine described by the
// prototype's "判据 N/M" fraction does not exist for the 8 cross-phase
// transitions; this is an honest manual override, not a fake gate check) ───

export function AdvancePhaseButton({
  sprintId,
  phase,
}: {
  sprintId: string;
  phase: string;
}) {
  const updateSprint = useUpdateSprint();
  const [open, setOpen] = useState(false);
  const currentIdx = SPRINT_PHASE_ORDER.indexOf(phase as SprintPhase);
  const nextPhase =
    currentIdx >= 0 && currentIdx < SPRINT_PHASE_ORDER.length - 1
      ? SPRINT_PHASE_ORDER[currentIdx + 1]
      : null;

  if (!nextPhase) return null;

  return (
    <>
      <Button size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
        <IconPlayerTrackNext className="size-4" />
        推进到 {SPRINT_PHASE_LABELS[nextPhase]}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              推进 Sprint 相位到「{SPRINT_PHASE_LABELS[nextPhase]}」？
            </AlertDialogTitle>
            <AlertDialogDescription>
              此操作直接把 sprint 相位设为「{SPRINT_PHASE_LABELS[nextPhase]}
              」，不做判据校验——跨相位的判据引擎（原型「判据 N/M」）本次未
              实现，这是一次人工手动推进。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                void updateSprint.mutateAsync({
                  id: sprintId,
                  phase: nextPhase,
                })
              }
            >
              确认推进
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────

export function SprintDetailPage() {
  const { id = "" } = useParams();
  const { data: rawSprint, isLoading } = useSprint(id);
  const sprint = rawSprint as SprintDetail | undefined;

  if (isLoading && !sprint) {
    return (
      <div className="mx-auto max-w-6xl space-y-5 p-6">
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
  const phase = sprint.phase ?? "planning";

  return (
    <div className="mx-auto max-w-6xl p-5 sm:p-6">
      {/* Back link */}
      <Button asChild variant="ghost" size="sm" className="-ml-2 mb-3 gap-1.5">
        <Link to="/sprints">
          <IconArrowLeft className="size-4" /> Sprint 列表
        </Link>
      </Button>

      {/* ── Header ── */}
      <header className="mb-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold leading-tight tracking-tight">
              {sprint.name}
            </h1>
            <Badge
              className={cn(
                "px-2 text-[11px]",
                sprintStatusColor(sprint.status),
              )}
            >
              {sprint.status}
            </Badge>
            <Badge className={cn("px-2 text-[11px]", phaseTone(phase))}>
              {SPRINT_PHASE_LABELS[phase as SprintPhase] ?? phase}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <ReleaseButton sprintId={id} status={sprint.status} />
            <AdvancePhaseButton sprintId={id} phase={phase} />
          </div>
        </div>
      </header>

      {/* ── 八相位 Stepper ── */}
      <SprintPhaseStepper phase={phase} />

      {/* ── Body ── */}
      <div className="mt-2 grid gap-5 lg:grid-cols-[1fr_320px]">
        {/* Left column */}
        <div className="order-2 min-w-0 space-y-5 lg:order-1">
          {phase === "executing" ? <ExecutingPhasePanel items={items} /> : null}
          <DeliveryProgressCard items={items} />
          <SprintItemsTable items={items} />
          <SprintBurndownChart sprintId={id} />
          <SprintStageTiming sprintId={id} />
          <SprintArtifactsSection sprintId={id} />
          <SprintApprovalsSection sprintId={id} />
        </div>

        {/* Right column: Inspector */}
        <aside className="order-1 lg:order-2">
          <div className="space-y-0 divide-y divide-border rounded-xl border border-border bg-card px-1 lg:sticky lg:top-4">
            <GoalCard sprintId={id} goal={sprint.goal ?? ""} />

            <InspectorSection label="Sprint">
              <MetaRow icon={IconGitBranch} label="分支">
                <span className="font-mono text-xs text-foreground/80">
                  {sprint.branch || "未配置"}
                </span>
              </MetaRow>
              <MetaRow icon={IconCalendar} label="起止">
                <span className="font-mono text-xs text-foreground/80">
                  {fmtDate(sprint.startDate)} ~ {fmtDate(sprint.endDate)}
                </span>
              </MetaRow>
            </InspectorSection>

            <InspectorSection label="签核">
              <GateMiniList sprintId={id} />
            </InspectorSection>

            <InspectorSection label="健康门">
              <HealthGateMini />
            </InspectorSection>

            <InspectorSection label="执行负责">
              {sprint.executorThreadId ? (
                <MetaRow icon={IconBrain} label="线程">
                  <div className="flex items-center gap-2">
                    <ActorAvatar kind="brain" size={22} />
                    <a
                      href={orchestratorBrainHref(sprint.executorThreadId)}
                      className="flex min-w-0 items-center gap-1 truncate font-mono text-xs text-foreground/80 hover:text-foreground hover:underline"
                    >
                      {sprint.executorThreadId.slice(0, 14)}…
                      <IconExternalLink className="size-3 shrink-0 opacity-60" />
                    </a>
                  </div>
                </MetaRow>
              ) : (
                <p className="px-3.5 py-2.5 text-xs text-muted-foreground">
                  未绑定执行线程
                </p>
              )}
            </InspectorSection>

            <InspectorSection label="度量摘要">
              <MetricsSummary sprint={sprint} />
            </InspectorSection>
          </div>
        </aside>
      </div>
    </div>
  );
}
