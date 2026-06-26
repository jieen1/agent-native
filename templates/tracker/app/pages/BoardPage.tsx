import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  useProjects,
  useWorkItems,
  useBulkDispatch,
  useItemActivityPoll,
} from "@/hooks/use-tracker";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  IconBrandGithub,
  IconGitBranch,
  IconInbox,
  IconLoader2,
  IconPlus,
  IconRobot,
  IconRocket,
} from "@tabler/icons-react";
import { NewWorkItemDialog } from "@/components/NewWorkItemDialog";
import { cn } from "@/lib/utils";
import {
  repoLabel,
  statusPresentation,
  typeChip,
} from "@/components/tracker-format";
import type { WorkItem } from "@shared/types";

// The board groups items into lifecycle lanes. `queued` and `running` reflect
// the orchestrator's live admission-gate slot state; `dispatched` is the legacy
// in-flight state for items dispatched before the gate resolved their slot.
const COLUMNS: Array<{ status: string[]; label: string; accent: string }> = [
  { status: ["open"], label: "待处理", accent: "bg-zinc-400" },
  { status: ["queued"], label: "排队中", accent: "bg-amber-500" },
  { status: ["running", "dispatched"], label: "运行中", accent: "bg-blue-500" },
  { status: ["done", "failed"], label: "已完成", accent: "bg-emerald-500" },
];

// Keeps a per-item get-activity poll alive while the item is in flight. The
// action writes the derived status (queued → running → done) back server-side,
// so mounting this drives the board's lane transitions without opening items.
function ItemActivityDriver({ workItemId }: { workItemId: string }) {
  useItemActivityPoll(workItemId, true);
  return null;
}

// ── Status chip (card) ───────────────────────────────────────────────────────

function StatusChip({ status }: { status: string }) {
  const pres = statusPresentation(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
        pres.chip,
      )}
    >
      <span
        className={cn(
          "size-1 rounded-full",
          pres.dot,
          pres.live && "animate-pulse",
        )}
      />
      {pres.label}
    </span>
  );
}

// ── Work item card ───────────────────────────────────────────────────────────

function WorkItemCard({
  item,
  projectKey,
  selectable,
  selected,
  onToggle,
}: {
  item: WorkItem;
  projectKey: string;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={cn(
        "group rounded-lg border bg-card p-3 shadow-sm transition-all hover:border-foreground/20 hover:shadow",
        selected ? "border-primary/60 ring-1 ring-primary/30" : "border-border",
      )}
      data-testid={`work-item-${item.id}`}
      data-status={item.status}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        {selectable ? (
          <Checkbox
            checked={selected}
            onCheckedChange={onToggle}
            aria-label={`选择 ${item.title}`}
            className="shrink-0"
          />
        ) : null}
        {projectKey ? (
          <span className="font-mono text-[10px] font-medium text-muted-foreground">
            {projectKey}
          </span>
        ) : null}
        <Badge
          variant="outline"
          className={cn(
            "h-4 px-1 text-[10px] capitalize",
            typeChip(item.type),
          )}
        >
          {item.type}
        </Badge>
        <span className="ml-auto" data-testid={`status-${item.status}`}>
          <StatusChip status={item.status} />
        </span>
      </div>

      <Link to={`/items/${item.id}`} className="block">
        <p className="line-clamp-2 text-sm font-medium leading-snug text-foreground group-hover:text-foreground">
          {item.title}
        </p>
        {item.description ? (
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {item.description}
          </p>
        ) : null}
      </Link>

      {item.orchestratorThreadId ? (
        <div className="mt-2 flex items-center gap-1.5 border-t border-border/60 pt-2">
          {statusPresentation(item.status).live ? (
            <IconLoader2 className="size-3 animate-spin text-blue-500" />
          ) : (
            <IconRobot className="size-3 text-emerald-500" />
          )}
          <span className="font-mono text-[10px] text-muted-foreground">
            智能体 · {item.orchestratorThreadId.slice(0, 8)}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function BoardPage() {
  const [params] = useSearchParams();
  const projectId = params.get("project") ?? undefined;
  const { data: projectsData } = useProjects();
  const projects = Array.isArray(projectsData) ? projectsData : [];
  const { data: itemsData, isLoading } = useWorkItems(projectId);
  const items = Array.isArray(itemsData) ? itemsData : [];

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const bulkDispatch = useBulkDispatch();

  const activeProject = projectId
    ? projects.find((p) => p.id === projectId)
    : undefined;

  const grouped = useMemo(() => {
    const byStatus: Record<string, WorkItem[]> = {
      open: [],
      queued: [],
      running: [],
      done: [],
    };
    for (const it of items) {
      const col = COLUMNS.find((c) => c.status.includes(it.status));
      const key = col ? col.status[0] : "open";
      (byStatus[key] ?? (byStatus[key] = [])).push(it);
    }
    return byStatus;
  }, [items]);

  const projectKeyById = useMemo(
    () => new Map(projects.map((p) => [p.id, p.key])),
    [projects],
  );

  // Items still in flight — drive their status writeback by polling get-activity.
  const inFlight = useMemo(
    () =>
      items.filter((it) =>
        ["queued", "running", "dispatched"].includes(it.status),
      ),
    [items],
  );

  // Selection is only meaningful for not-yet-dispatched (open) items.
  const selectableIds = useMemo(
    () => items.filter((it) => it.status === "open").map((it) => it.id),
    [items],
  );
  const selectedCount = selected.size;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === selectableIds.length ? new Set() : new Set(selectableIds),
    );
  }

  async function dispatchSelected() {
    if (!selectedCount) return;
    const ids = Array.from(selected);
    await bulkDispatch.mutateAsync({ workItemIds: ids });
    setSelected(new Set());
  }

  const repoText = activeProject ? repoLabel(activeProject.gitRemote) : null;

  return (
    <div className="flex h-full flex-col">
      {/* Mount invisible drivers that poll get-activity for in-flight items so
          the board lanes auto-advance (queued → running → done). */}
      {inFlight.map((it) => (
        <ItemActivityDriver key={`drv-${it.id}`} workItemId={it.id} />
      ))}

      {/* ── Toolbar ── */}
      <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold tracking-tight">
            {activeProject ? activeProject.name : "全部工作项"}
          </h2>
          {activeProject ? (
            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              <span className="flex items-center gap-1 truncate">
                <IconBrandGithub className="size-3 shrink-0" />
                {repoText ?? "未配置仓库"}
              </span>
              <span className="flex items-center gap-1">
                <IconGitBranch className="size-3 shrink-0" />
                {activeProject.defaultBranch}
              </span>
            </div>
          ) : (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {items.length} 个工作项 · 覆盖所有项目
            </p>
          )}
        </div>
        <NewWorkItemDialog defaultProjectId={projectId}>
          <Button size="sm" className="gap-1.5" disabled={projects.length === 0}>
            <IconPlus className="size-4" />
            新建工作项
          </Button>
        </NewWorkItemDialog>
      </div>

      {/* ── Bulk-dispatch action bar ── */}
      {selectableIds.length > 0 ? (
        <div className="flex items-center gap-3 border-b border-border bg-muted/40 px-6 py-2">
          <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground">
            <Checkbox
              checked={
                selectedCount > 0 && selectedCount === selectableIds.length
              }
              onCheckedChange={toggleAll}
              aria-label="全选待处理工作项"
            />
            全选待处理 ({selectableIds.length})
          </label>
          <div className="ml-auto flex items-center gap-3">
            {selectedCount > 0 ? (
              <span className="text-xs font-medium text-foreground">
                已选 {selectedCount} 项
              </span>
            ) : null}
            <Button
              size="sm"
              className="gap-1.5"
              disabled={selectedCount === 0 || bulkDispatch.isPending}
              onClick={dispatchSelected}
            >
              {bulkDispatch.isPending ? (
                <IconLoader2 className="size-4 animate-spin" />
              ) : (
                <IconRocket className="size-4" />
              )}
              {bulkDispatch.isPending
                ? "派发中…"
                : `派发所选${selectedCount ? ` (${selectedCount})` : ""}`}
            </Button>
          </div>
        </div>
      ) : null}

      {/* ── Board ── */}
      {projects.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8 text-center">
          <div className="max-w-sm">
            <div className="mx-auto mb-3 w-fit rounded-full bg-muted/60 p-3">
              <IconInbox className="size-6 text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground">
              还没有项目。先创建一个项目并一次性设置好仓库与分支,即可开始添加工作项。
            </p>
            <Button asChild className="mt-4">
              <Link to="/projects">前往项目</Link>
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid flex-1 grid-cols-1 gap-4 overflow-auto p-6 md:grid-cols-2 xl:grid-cols-4">
          {COLUMNS.map((col) => {
            const colItems = grouped[col.status[0]] ?? [];
            return (
              <div key={col.label} className="flex min-w-0 flex-col">
                {/* Column header */}
                <div className="mb-3 flex items-center gap-2">
                  <span className={cn("size-2 rounded-full", col.accent)} />
                  <h3 className="text-sm font-semibold">{col.label}</h3>
                  <Badge
                    variant="secondary"
                    className="h-5 min-w-5 justify-center px-1.5 font-mono text-[11px]"
                  >
                    {colItems.length}
                  </Badge>
                </div>

                {/* Cards */}
                <div className="flex flex-col gap-2.5 rounded-xl bg-muted/30 p-2">
                  {isLoading &&
                  colItems.length === 0 &&
                  col.status.includes("open")
                    ? Array.from({ length: 2 }).map((_, i) => (
                        <Skeleton key={i} className="h-24 w-full rounded-lg" />
                      ))
                    : null}
                  {colItems.map((it) => (
                    <WorkItemCard
                      key={it.id}
                      item={it}
                      projectKey={projectKeyById.get(it.projectId) ?? ""}
                      selectable={it.status === "open"}
                      selected={selected.has(it.id)}
                      onToggle={() => toggle(it.id)}
                    />
                  ))}
                  {!isLoading && colItems.length === 0 ? (
                    <p className="px-2 py-6 text-center text-xs text-muted-foreground/60">
                      暂无内容。
                    </p>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
