import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useSprints, useCreateSprint, useProjects } from "@/hooks/use-tracker";
import type { Sprint } from "@shared/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  IconCalendar,
  IconFilter,
  IconGitBranch,
  IconPackage,
  IconPlus,
  IconSearch,
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

const SPRINT_PHASE_LABEL: Record<string, string> = {
  planning: '规划',
  executing: '执行中',
  done: '已完成',
};
function sprintPhaseLabel(phase: string): string {
  return SPRINT_PHASE_LABEL[phase] ?? phase;
}
function sprintPhaseColor(phase: string): string {
  switch (phase) {
    case 'planning':
      return 'bg-secondary text-secondary-foreground';
    case 'executing':
      return 'bg-blue-500 text-white';
    case 'done':
      return 'bg-emerald-500 text-white';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

function fmtDate(d: string): string {
  if (!d) return "—";
  return d.slice(0, 10);
}

// ── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({
  value,
  label,
  dot,
  icon,
}: {
  value: number;
  label: string;
  dot: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card p-4 shadow-sm">
      <div
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-full",
          dot,
        )}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-2xl font-semibold leading-tight tracking-tight">
          {value}
        </p>
        <p className="truncate text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

// ── Sprint Card ──────────────────────────────────────────────────────────────

function SprintCard({ sprint }: { sprint: Sprint }) {
  const completed =
    sprint.status === "已完成" || sprint.status === "已发布";

  const delivered = sprint.delivered ?? 0;
  const total = sprint.itemCount ?? 0;
  const percent = total > 0 ? Math.round((delivered / total) * 100) : 0;

  return (
    <div className="group flex flex-col rounded-xl border border-border bg-card p-5 shadow-sm transition-all hover:border-foreground/20 hover:shadow">
      {/* Header: name + status badge */}
      <div className="mb-2 flex items-start justify-between gap-2">
        <h3 className="line-clamp-1 text-base font-semibold leading-snug text-foreground">
          {sprint.name}
        </h3>
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge
            variant={sprintStatusVariant(sprint.status)}
            className={cn("px-2 text-[11px]", sprintStatusColor(sprint.status))}
          >
            {sprint.status}
          </Badge>
          <Badge
            className={cn("px-2 text-[11px]", sprintPhaseColor(sprint.phase ?? "planning"))}
          >
            {sprintPhaseLabel(sprint.phase ?? "planning")}
          </Badge>
        </div>
      </div>

      {/* Goal */}
      {sprint.goal ? (
        <p className="mb-3 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
          {sprint.goal}
        </p>
      ) : null}

      {/* Branch */}
      {sprint.branch ? (
        <p className="mb-2 flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
          <IconGitBranch className="size-3.5 shrink-0" />
          {sprint.branch}
          <span className="text-muted-foreground/50">← main</span>
        </p>
      ) : null}

      {/* Date range */}
      {sprint.startDate || sprint.endDate ? (
        <p className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          <IconCalendar className="size-3.5 shrink-0" />
          {fmtDate(sprint.startDate)}
          {sprint.startDate && sprint.endDate ? " → " : ""}
          {fmtDate(sprint.endDate)}
        </p>
      ) : null}

      {/* Progress: custom div-based progress bar */}
      <div className="mb-4 flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">
          已交付 {delivered}/共 {total}
        </p>
        <div className="relative h-2 w-full overflow-hidden rounded-full bg-primary/30">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      {/* Actions */}
      <div className="mt-auto flex items-center gap-2 border-t border-border/60 pt-3">
        <Button asChild size="sm" variant="outline" className="gap-1.5 flex-1">
          <Link to={`/sprints/${sprint.id}`}>打开</Link>
        </Button>
        {completed ? (
          <Button size="sm" className="gap-1.5 flex-1">
            发布 Sprint
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────

export function SprintsPage() {
  const { data, isLoading } = useSprints();
  const sprints = Array.isArray(data) ? data : [];
  const { data: projectsData } = useProjects();
  const projects = Array.isArray(projectsData) ? projectsData : [];
  const createSprint = useCreateSprint();

  const [statusFilter, setStatusFilter] = useState<string>("全部");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newGoal, setNewGoal] = useState("");
  const [newProjectId, setNewProjectId] = useState("");

  async function handleCreateSprint() {
    const projectId = newProjectId || projects[0]?.id;
    if (!projectId || !newName.trim()) return;
    await createSprint.mutateAsync({ projectId, name: newName.trim(), goal: newGoal.trim() || undefined });
    setCreateOpen(false);
    setNewName("");
    setNewGoal("");
  }

  const stats = useMemo(() => {
    let inProgress = 0;
    let toPublish = 0;
    let activeItems = 0;
    let queued = 0;
    for (const s of sprints) {
      if (s.status === "进行中") inProgress += 1;
      if (s.status === "已完成") toPublish += 1;
      if (s.status === "进行中" || s.status === "规划") {
        const itemCount = s.itemCount ?? 0;
        activeItems += itemCount;
        queued += Math.max(0, itemCount - (s.delivered ?? 0));
      }
    }
    return { inProgress, toPublish, activeItems, queued };
  }, [sprints]);

  const filtered = useMemo(() => {
    let list = sprints;
    if (statusFilter !== "全部") {
      list = list.filter((s) => s.status === statusFilter);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.goal ?? "").toLowerCase().includes(q) ||
          (s.branch ?? "").toLowerCase().includes(q),
      );
    }
    return list;
  }, [sprints, statusFilter, search]);

  return (
    <div className="mx-auto max-w-6xl p-5 sm:p-6">
      {/* ── Create Sprint Dialog ── */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>新建 Sprint</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            {projects.length > 1 && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sprint-project">项目</Label>
                <Select value={newProjectId} onValueChange={setNewProjectId}>
                  <SelectTrigger id="sprint-project">
                    <SelectValue placeholder="选择项目" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((p: any) => (
                      <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sprint-name">Sprint 名称 *</Label>
              <Input
                id="sprint-name"
                placeholder="例：v2.1 迭代"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreateSprint()}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sprint-goal">目标（选填）</Label>
              <Input
                id="sprint-goal"
                placeholder="这个 Sprint 要完成什么？"
                value={newGoal}
                onChange={(e) => setNewGoal(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button
              onClick={handleCreateSprint}
              disabled={!newName.trim() || createSprint.isPending}
            >
              {createSprint.isPending ? "创建中…" : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Header ── */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Sprint</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            跟踪每个 Sprint 的目标、进度与交付情况。
          </p>
        </div>
        <Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}>
          <IconPlus className="size-4" />
          新建 Sprint
        </Button>
      </div>

      {/* ── Stat cards ── */}
      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          value={stats.inProgress}
          label="进行中"
          dot="bg-blue-100 dark:bg-blue-900/30"
          icon={<IconPackage className="size-4 text-blue-600 dark:text-blue-400" />}
        />
        <StatCard
          value={stats.toPublish}
          label="待发布"
          dot="bg-emerald-100 dark:bg-emerald-900/30"
          icon={<IconPackage className="size-4 text-emerald-600 dark:text-emerald-400" />}
        />
        <StatCard
          value={stats.activeItems}
          label="活跃工作项"
          dot="bg-amber-100 dark:bg-amber-900/30"
          icon={<IconPackage className="size-4 text-amber-600 dark:text-amber-400" />}
        />
        <StatCard
          value={stats.queued}
          label="队列中"
          dot="bg-purple-100 dark:bg-purple-900/30"
          icon={<IconPackage className="size-4 text-purple-600 dark:text-purple-400" />}
        />
      </div>

      {/* ── Filter bar ── */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <IconFilter className="size-3.5" />
          筛选:
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-8 w-36 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="全部">全部状态</SelectItem>
            <SelectItem value="规划">规划</SelectItem>
            <SelectItem value="进行中">进行中</SelectItem>
            <SelectItem value="已完成">已完成</SelectItem>
            <SelectItem value="已发布">已发布</SelectItem>
          </SelectContent>
        </Select>
        <div className="relative flex-1">
          <IconSearch className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="搜索 Sprint 名称、目标或分支…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 pl-9 text-sm"
          />
        </div>
      </div>

      {/* ── Grid ── */}
      {isLoading && sprints.length === 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-48 w-full rounded-xl" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-muted/20 px-6 py-16 text-center">
          <p className="text-sm font-medium">暂无 Sprint</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            点击「新建 Sprint」开始创建第一个迭代。
          </p>
          <Button size="sm" className="mt-1 gap-1.5" onClick={() => setCreateOpen(true)}>
            <IconPlus className="size-4" />
            新建 Sprint
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((sprint) => (
            <SprintCard key={sprint.id} sprint={sprint} />
          ))}
        </div>
      )}
    </div>
  );
}
