import { useParams } from "react-router";
import { Link } from "react-router";
import { useSprint } from "@/hooks/use-tracker";
import type { SprintDetail, TrackerWorkItem, Stage } from "@/shared/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  IconArrowLeft,
  IconCalendar,
  IconGitBranch,
  IconPackage,
  IconPlus,
  IconClock,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";

// ── Helpers ──────────────────────────────────────────────────────────────────

function sprintStatusVariant(status: string): "default" | "secondary" | "outline" {
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
    case 1: return "P0";
    case 2: return "P1";
    case 3: return "P2";
    case 4: return "P3";
    default: return "P?";
  }
}

function priorityColor(p: number): string {
  switch (p) {
    case 1: return "bg-red-500 text-white";
    case 2: return "bg-orange-500 text-white";
    case 3: return "bg-amber-500 text-white";
    case 4: return "bg-blue-500 text-white";
    default: return "bg-muted text-muted-foreground";
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
    case "待办": return "bg-gray-300 dark:bg-gray-600";
    case "分析": return "bg-amber-400";
    case "设计": return "bg-yellow-400";
    case "实施": return "bg-blue-400";
    case "测试": return "bg-purple-400";
    case "验收": return "bg-indigo-400";
    case "交付": return "bg-emerald-400";
    default: return "bg-gray-300";
  }
}

function stageStatusLabel(status: string): { label: string; color: string } {
  switch (status) {
    case "待执行": return { label: "待执行", color: "text-gray-500" };
    case "执行中": return { label: "执行中", color: "text-blue-500" };
    case "已完成": return { label: "已完成", color: "text-emerald-500" };
    case "已驳回": return { label: "已驳回", color: "text-red-500" };
    case "跳过": return { label: "跳过", color: "text-gray-400" };
    default: return { label: status, color: "text-muted-foreground" };
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

function DeliveryProgressCard({
  items,
}: {
  items: TrackerWorkItem[];
}) {
  const stageOrder = ["待办", "分析", "设计", "实施", "测试", "验收", "交付"] as const;

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
          const pct = totalItems > 0 ? Math.round((count / totalItems) * 100) : 0;
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
                  className={cn("h-full transition-all", stageColors(stageName))}
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
              {/* Item key */}
              <span className="w-16 shrink-0 font-mono text-[11px] font-medium text-muted-foreground">
                {item.itemKey}
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
                className={cn("h-5 px-1.5 text-[11px]", itemTypeColor(item.type))}
              >
                {item.type}
              </Badge>

              {/* Priority badge */}
              <Badge
                variant="outline"
                className={cn("h-5 px-1.5 text-[11px]", priorityColor(item.priority))}
              >
                {priorityLabel(item.priority)}
              </Badge>

              {/* Current stage · stageStatus */}
              {currentStage ? (
                <span className="flex shrink-0 items-center gap-1 text-xs">
                  <span className="font-medium text-foreground">
                    {currentStage.stageName}
                  </span>
                  <span className={cn("text-muted-foreground", stageStatusLabel(currentStage.stageStatus).color)}>
                    · {stageStatusLabel(currentStage.stageStatus).label}
                  </span>
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">—</span>
              )}

              {/* Assignee avatar (small) */}
              <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
                {item.assigneeName ? item.assigneeName[0] : "?"}
              </div>
            </div>
          );
        })}
      </div>
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
        </div>

        <h1 className="text-2xl font-semibold leading-tight tracking-tight">
          {sprint.name}
        </h1>

        {sprint.goal ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {sprint.goal}
          </p>
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
        {/* Left column: progress + items */}
        <div className="order-2 min-w-0 space-y-5 lg:order-1">
          <DeliveryProgressCard items={items} />
          <SprintItemsCard sprint={sprint} items={items} stages={stages} />
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
