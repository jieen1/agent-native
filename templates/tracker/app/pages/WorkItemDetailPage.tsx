import { useState } from "react";
import { useParams, Link } from "react-router";
import { useActivity, useDispatch, useStages, useWorkItem } from "@/hooks/use-tracker";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconBrandGithub,
  IconCheck,
  IconClock,
  IconExternalLink,
  IconFlag,
  IconGitBranch,
  IconHash,
  IconLayoutKanban,
  IconListCheck,
  IconLoader2,
  IconMessageCircle,
  IconRocket,
  IconStack2,
  IconTag,
  IconX,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { ActivityFeed } from "@/components/ActivityFeed";
import {
  fmtDateTime,
  orchestratorBrainHref,
  repoHref,
  repoLabel,
  statusPresentation,
  typeChip,
} from "@/components/tracker-format";

// ── Stage stepper ────────────────────────────────────────────────────────────

const STAGE_NODES = ["待办", "分析", "设计", "实施", "测试", "验收", "交付"] as const;

function StageNode({ status, name }: { status: string; name: string }) {
  if (status === "已完成") {
    return (
      <div className="flex flex-col items-center gap-1.5 relative z-10">
        <div className="size-5 rounded-full bg-emerald-500 flex items-center justify-center">
          <IconCheck className="size-3 text-white" strokeWidth={3} />
        </div>
        <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400">{name}</span>
      </div>
    );
  }
  if (status === "执行中") {
    return (
      <div className="flex flex-col items-center gap-1.5 relative z-10">
        <div className="size-5 rounded-full bg-blue-500 flex items-center justify-center ring-4 ring-blue-500/20">
          <span className="size-2 rounded-full bg-white animate-pulse" />
        </div>
        <span className="text-[10px] font-bold text-blue-600 dark:text-blue-400">{name}</span>
      </div>
    );
  }
  if (status === "已驳回") {
    return (
      <div className="flex flex-col items-center gap-1.5 relative z-10">
        <div className="size-5 rounded-full bg-red-400 flex items-center justify-center">
          <IconX className="size-3 text-white" strokeWidth={3} />
        </div>
        <span className="text-[10px] font-medium text-red-500">{name}</span>
      </div>
    );
  }
  if (status === "跳过") {
    return (
      <div className="flex flex-col items-center gap-1.5 relative z-10">
        <div className="size-5 rounded-full border-2 border-dashed border-slate-400 flex items-center justify-center">
          <span className="text-[10px] text-slate-400">—</span>
        </div>
        <span className="text-[10px] font-medium text-slate-400 line-through">{name}</span>
      </div>
    );
  }
  // 待执行 / unknown
  return (
    <div className="flex flex-col items-center gap-1.5 relative z-10">
      <div className="size-5 rounded-full border-2 border-slate-300 dark:border-slate-600" />
      <span className="text-[10px] font-medium text-muted-foreground">{name}</span>
    </div>
  );
}

function StageLine({ prevDone }: { prevDone: boolean }) {
  return prevDone
    ? <div className="flex-1 h-px bg-emerald-500 my-2.5" />
    : <div className="flex-1 h-px border border-dashed border-slate-300 dark:border-slate-600 my-2.5" />;
}

function StageProgressCard({ workItemId, currentStageName }: { workItemId: string; currentStageName: string }) {
  const { data, isLoading } = useStages(workItemId);
  const stages: any[] = Array.isArray(data) ? data : [];
  const stageMap: Record<string, string> = {};
  for (const s of stages) stageMap[s.stageName] = s.stageStatus;

  // 待办 is completed once any real stage exists or currentStageName != 待办
  const pendingDone = currentStageName !== "待办" || stages.length > 0;
  const nodeStatuses: Record<string, string> = {
    待办: pendingDone ? "已完成" : "执行中",
    分析: stageMap["分析"] ?? "待执行",
    设计: stageMap["设计"] ?? "待执行",
    实施: stageMap["实施"] ?? "待执行",
    测试: stageMap["测试"] ?? "待执行",
    验收: stageMap["验收"] ?? "待执行",
    交付: stageMap["交付"] ?? "待执行",
  };

  const currentLabel = nodeStatuses[currentStageName] === "执行中"
    ? `${currentStageName} · 执行中`
    : currentStageName === "交付" && nodeStatuses["交付"] === "已完成"
      ? "交付 · 已完成"
      : `${currentStageName}`;

  const currentBadgeClass = nodeStatuses[currentStageName] === "已完成" || currentStageName === "交付"
    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 ring-1 ring-inset ring-emerald-500/30"
    : "bg-blue-500/15 text-blue-600 dark:text-blue-400 ring-1 ring-inset ring-blue-500/30";

  const currentDot = nodeStatuses[currentStageName] === "已完成"
    ? "bg-emerald-500"
    : "bg-blue-500 animate-pulse";

  if (isLoading) {
    return (
      <div className="rounded-lg border border-border bg-card shadow-sm p-5 animate-pulse h-24" />
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card shadow-sm p-5">
      <div className="flex items-center justify-between mb-5">
        <h3 className="text-sm font-semibold">阶段进度</h3>
        <span className="text-xs text-muted-foreground">仅展示状态</span>
      </div>

      {/* Horizontal stepper */}
      <div className="flex items-start">
        {STAGE_NODES.map((name, i) => {
          const st = nodeStatuses[name];
          const prevDone = i === 0 ? false : nodeStatuses[STAGE_NODES[i - 1]] === "已完成";
          return (
            <>
              {i > 0 && <StageLine key={`line-${i}`} prevDone={prevDone} />}
              <StageNode key={name} name={name} status={st} />
            </>
          );
        })}
      </div>

      {/* Current stage badge */}
      <div className="mt-4 flex items-center gap-2">
        <span className="text-xs text-muted-foreground">当前:</span>
        <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium", currentBadgeClass)}>
          <span className={cn("size-1.5 rounded-full", currentDot)} />
          {currentLabel}
        </span>
      </div>
    </div>
  );
}

// ── Small status chip (header) ───────────────────────────────────────────────

function StatusChip({ status }: { status: string }) {
  const pres = statusPresentation(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        pres.chip,
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          pres.dot,
          pres.live && "animate-pulse",
        )}
      />
      {pres.label}
    </span>
  );
}

// ── Metadata row (definition list) ───────────────────────────────────────────

function MetaRow({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof IconBrandGithub;
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

export function WorkItemDetailPage() {
  const { id = "" } = useParams();
  const { data: item, isLoading } = useWorkItem(id);
  const dispatch = useDispatch();
  const dispatched = !!item?.orchestratorThreadId;
  const activity = useActivity(id, dispatched);

  // Monitor interval (sec) for the orchestrator brain's periodic drift-check
  // wake. Blank → server default (120); 0 → event-only (no timer wakes).
  const [monitorInterval, setMonitorInterval] = useState("");

  function onDispatch() {
    const trimmed = monitorInterval.trim();
    const parsed = trimmed === "" ? undefined : Number(trimmed);
    const monitorIntervalSec =
      parsed !== undefined && Number.isFinite(parsed) && parsed >= 0
        ? Math.floor(parsed)
        : undefined;
    dispatch.mutate(
      monitorIntervalSec !== undefined
        ? { workItemId: id, monitorIntervalSec }
        : { workItemId: id },
      {
        onSuccess: (res: { threadId: string }) => {
          toast.success(
            `已派发 — 大脑线程 ${res.threadId.slice(0, 12)}…`,
          );
        },
      },
    );
  }

  if (isLoading && !item) {
    return (
      <div className="mx-auto max-w-5xl space-y-5 p-6">
        <Skeleton className="h-7 w-24" />
        <Skeleton className="h-9 w-2/3" />
        <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
          <Skeleton className="h-64 w-full rounded-xl" />
          <Skeleton className="h-48 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  if (!item) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <p className="text-sm text-muted-foreground">未找到该工作项。</p>
        <Button asChild variant="ghost" className="mt-3 gap-1.5">
          <Link to="/board">
            <IconArrowLeft className="size-4" /> 返回看板
          </Link>
        </Button>
      </div>
    );
  }

  const slot = activity.data?.slot;
  const queue = activity.data?.queue;
  const status = activity.data?.itemStatus ?? item.status;
  const remote = item.project?.gitRemote;
  const branch = item.project?.defaultBranch ?? "main";
  const ghHref = repoHref(remote);
  const ghLabel = repoLabel(remote);

  const RISK_MAP: Record<string, string> = { low: "低", medium: "中", high: "高" };
  const PRIORITY_MAP: Record<number, string> = { 1: "P0", 2: "P1", 3: "P2", 4: "P3" };
  const riskVal = (item as { risk?: string }).risk ?? "medium";
  const riskLabel = RISK_MAP[riskVal] ?? riskVal;
  const priorityLabel = PRIORITY_MAP[item.priority] ?? `P${item.priority}`;
  const tags = (item as { tags?: string[] }).tags ?? [];
  const sprint = (item as { sprint?: { id: string; name: string; status: string } | null }).sprint;
  const itemKey = (item as { itemKey?: string }).itemKey;
  const currentStageName = (item as { currentStageName?: string }).currentStageName ?? "待办";

  return (
    <div className="mx-auto max-w-5xl p-5 sm:p-6">
      {/* Back link */}
      <Button asChild variant="ghost" size="sm" className="-ml-2 mb-3 gap-1.5">
        <Link to={`/board?project=${encodeURIComponent(item.projectId)}`}>
          <IconArrowLeft className="size-4" /> 看板
        </Link>
      </Button>

      {/* ── Header ── */}
      <header className="mb-5">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {item.project?.key ? (
            <span className="font-mono text-xs font-medium text-muted-foreground">
              {item.project.key}
            </span>
          ) : null}
          <Badge
            variant="outline"
            className={cn("h-5 px-1.5 text-[11px] capitalize", typeChip(item.type))}
          >
            {item.type}
          </Badge>
          <StatusChip status={status} />
          {slot?.status === "queued" && queue ? (
            <span className="text-xs text-muted-foreground">
              排队中 · {queue.running}/{queue.brainConcurrency} 个槽位忙碌
            </span>
          ) : null}
          {slot?.status === "running" ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 dark:text-blue-400">
              <IconLoader2 className="size-3.5 animate-spin" />
              运行中
            </span>
          ) : null}
        </div>

        <h1 className="text-2xl font-semibold leading-tight tracking-tight">
          {item.title}
        </h1>

        {/* Controls row */}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            onClick={onDispatch}
            disabled={dispatch.isPending}
            className="gap-1.5"
            variant={dispatched ? "outline" : "default"}
          >
            {dispatch.isPending ? (
              <IconLoader2 className="size-4 animate-spin" />
            ) : (
              <IconRocket className="size-4" />
            )}
            {dispatch.isPending
              ? "派发中…"
              : dispatched
                ? "重新派发"
                : "派发给编排器"}
          </Button>

          <div className="flex items-center gap-2">
            <Label
              htmlFor="monitor-interval"
              className="whitespace-nowrap text-xs text-muted-foreground"
            >
              监控间隔
            </Label>
            <div className="relative">
              <Input
                id="monitor-interval"
                type="number"
                min={0}
                inputMode="numeric"
                placeholder="120"
                value={monitorInterval}
                onChange={(e) => setMonitorInterval(e.target.value)}
                className="h-8 w-24 pr-9 text-sm"
                title="周期性漂移检查的节奏。留空 = 默认 120 秒。0 = 仅事件触发(无定时唤醒)。"
              />
              <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-[11px] text-muted-foreground">
                秒
              </span>
            </div>
          </div>

          {dispatched && item.orchestratorThreadId ? (
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="ml-auto h-8 gap-1.5 text-muted-foreground"
            >
              <a href={orchestratorBrainHref(item.orchestratorThreadId)}>
                <IconMessageCircle className="size-3.5" />
                打开大脑线程
                <IconExternalLink className="size-3 opacity-60" />
              </a>
            </Button>
          ) : null}
        </div>
      </header>

      {/* ── Body: requirement + activity (left) · context (right) ── */}
      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        {/* Left column */}
        <div className="order-2 min-w-0 space-y-6 lg:order-1">
          {/* Stage progress card */}
          <StageProgressCard workItemId={id} currentStageName={currentStageName} />

          {/* Requirement */}
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              需求
            </h2>
            <div className="rounded-xl border border-border bg-card/40 p-4">
              {item.description ? (
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90">
                  {item.description}
                </p>
              ) : (
                <p className="text-sm italic text-muted-foreground">
                  暂无需求描述。
                </p>
              )}
            </div>
          </section>

          {/* Activity — the centerpiece */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                动态
              </h2>
              {dispatched ? (
                <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      activity.isLoading
                        ? "bg-amber-500 animate-pulse"
                        : "bg-emerald-500",
                    )}
                  />
                  {activity.data?.thread?.status
                    ? `大脑 ${activity.data.thread.status}`
                    : "实时"}
                </span>
              ) : null}
            </div>
            <ActivityFeed
              dispatched={dispatched}
              activity={activity.data}
              isLoading={activity.isLoading}
            />
          </section>
        </div>

        {/* Right column: context */}
        <aside className="order-1 lg:order-2">
          <div className="divide-y divide-border rounded-xl border border-border bg-card lg:sticky lg:top-4">
            {itemKey ? (
              <MetaRow icon={IconHash} label="编号">
                <span className="font-mono text-xs">{itemKey}</span>
              </MetaRow>
            ) : null}

            {sprint ? (
              <MetaRow icon={IconStack2} label="Sprint">
                <span className="text-sm font-medium">{sprint.name}</span>
                <Badge variant="secondary" className="ml-2 h-4 px-1.5 text-[10px]">
                  {sprint.status}
                </Badge>
              </MetaRow>
            ) : null}

            <MetaRow icon={IconListCheck} label="当前阶段">
              <span className="text-sm">{currentStageName}</span>
            </MetaRow>

            <MetaRow icon={IconFlag} label="优先级">
              <span className="text-sm">{priorityLabel}</span>
            </MetaRow>

            <MetaRow icon={IconAlertTriangle} label="风险">
              <span className={cn(
                "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium",
                riskVal === "high"
                  ? "border-red-300 bg-red-50 text-red-600 dark:border-red-700 dark:bg-red-900/20 dark:text-red-400"
                  : riskVal === "medium"
                  ? "border-amber-300 bg-amber-50 text-amber-600 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-400"
                  : "border-emerald-300 bg-emerald-50 text-emerald-600 dark:border-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400"
              )}>
                {riskLabel}
              </span>
            </MetaRow>

            {tags.length > 0 ? (
              <MetaRow icon={IconTag} label="标签">
                <div className="flex flex-wrap gap-1">
                  {tags.map((tag: string) => (
                    <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {tag}
                    </span>
                  ))}
                </div>
              </MetaRow>
            ) : null}

            <MetaRow icon={IconLayoutKanban} label="项目">
              <Link
                to={`/board?project=${encodeURIComponent(item.projectId)}`}
                className="truncate font-medium text-foreground hover:underline"
              >
                {item.project?.name ?? item.projectId}
              </Link>
            </MetaRow>

            <MetaRow icon={IconBrandGithub} label="仓库">
              {ghHref ? (
                <a
                  href={ghHref}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 break-all font-mono text-xs hover:text-foreground hover:underline"
                  title={remote ?? undefined}
                >
                  {ghLabel}
                  <IconExternalLink className="size-3 shrink-0 opacity-60" />
                </a>
              ) : (
                <span className="break-all font-mono text-xs text-muted-foreground">
                  {ghLabel ?? "未配置仓库"}
                </span>
              )}
            </MetaRow>

            <MetaRow icon={IconGitBranch} label="分支">
              <span className="font-mono text-xs text-foreground/80">
                {branch}
              </span>
            </MetaRow>

            {item.orchestratorThreadId ? (
              <MetaRow icon={IconMessageCircle} label="大脑">
                <TooltipProvider delayDuration={300}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <a
                        href={orchestratorBrainHref(item.orchestratorThreadId)}
                        className="flex items-center gap-1 font-mono text-xs text-foreground/80 hover:text-foreground hover:underline"
                      >
                        {item.orchestratorThreadId.slice(0, 16)}…
                        <IconExternalLink className="size-3 shrink-0 opacity-60" />
                      </a>
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      <span className="font-mono text-xs">
                        {item.orchestratorThreadId}
                      </span>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </MetaRow>
            ) : null}

            <MetaRow icon={IconClock} label="创建时间">
              <span className="text-xs text-muted-foreground">
                {fmtDateTime(item.createdAt)}
              </span>
            </MetaRow>
          </div>
        </aside>
      </div>
    </div>
  );
}
