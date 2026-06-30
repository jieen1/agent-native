import { useMemo } from "react";
import { Link } from "react-router";
import { useProjects, useWorkItems } from "@/hooks/use-tracker";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  IconArrowRight,
  IconBrandGithub,
  IconFolders,
  IconGitBranch,
  IconLoader2,
  IconPlus,
  IconSettings,
} from "@tabler/icons-react";
import { NewProjectDialog } from "@/components/NewProjectDialog";
import { cn } from "@/lib/utils";
import { repoLabel } from "@/components/tracker-format";
import type { WorkItem } from "@shared/types";

interface Counts {
  total: number;
  open: number;
  inFlight: number;
  done: number;
}

function countFor(items: WorkItem[]): Counts {
  const c: Counts = { total: 0, open: 0, inFlight: 0, done: 0 };
  for (const it of items) {
    c.total += 1;
    if (it.status === "open") c.open += 1;
    else if (["queued", "running", "dispatched"].includes(it.status))
      c.inFlight += 1;
    else if (it.status === "done") c.done += 1;
  }
  return c;
}

function CountPill({
  value,
  label,
  dot,
  spin,
}: {
  value: number;
  label: string;
  dot: string;
  spin?: boolean;
}) {
  if (value === 0) return null;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card/50 px-2 py-1 text-xs">
      <span
        className={cn("size-1.5 rounded-full", dot, spin && "animate-pulse")}
      />
      <span className="font-mono font-medium text-foreground">{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

export function ProjectsPage() {
  const { data, isLoading } = useProjects();
  const projects = Array.isArray(data) ? data : [];
  const { data: itemsData } = useWorkItems();
  const items = Array.isArray(itemsData) ? itemsData : [];

  const countsByProject = useMemo(() => {
    const map = new Map<string, WorkItem[]>();
    for (const it of items) {
      (
        map.get(it.projectId) ?? map.set(it.projectId, []).get(it.projectId)!
      ).push(it);
    }
    return map;
  }, [items]);

  return (
    <div className="mx-auto max-w-5xl p-5 sm:p-6">
      {/* ── Header ── */}
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">项目</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            为每个项目配置一次代码仓库和默认分支。工作项在派发时会继承该上下文。
          </p>
        </div>
        <NewProjectDialog>
          <Button size="sm" className="gap-1.5">
            <IconPlus className="size-4" />
            新建项目
          </Button>
        </NewProjectDialog>
      </div>

      {isLoading && projects.length === 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-36 w-full rounded-xl" />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-muted/20 px-6 py-16 text-center">
          <div className="rounded-full bg-muted/60 p-3">
            <IconFolders className="size-6 text-muted-foreground" />
          </div>
          <p className="text-sm font-medium">暂无项目</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            创建你的第一个项目以配置其代码仓库,并开始添加工作项。
          </p>
          <NewProjectDialog>
            <Button className="mt-1 gap-1.5">
              <IconPlus className="size-4" />
              新建项目
            </Button>
          </NewProjectDialog>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {projects.map((p) => {
            const counts = countFor(countsByProject.get(p.id) ?? []);
            const repoText = repoLabel(p.gitRemote);
            return (
              <div
                key={p.id}
                className="group flex h-full flex-col rounded-xl border border-border bg-card p-4 shadow-sm transition-all hover:border-foreground/20 hover:shadow"
              >
                {/* Title */}
                <div className="mb-2 flex items-start gap-2">
                  <span className="inline-flex h-5 shrink-0 items-center rounded bg-muted px-1.5 font-mono text-[11px] font-semibold text-muted-foreground">
                    {p.key}
                  </span>
                  <Link
                    to={`/board?project=${encodeURIComponent(p.id)}`}
                    className="min-w-0 flex-1 truncate text-base font-semibold leading-6 text-foreground hover:underline"
                  >
                    {p.name}
                  </Link>
                  <Link
                    to={`/projects/${p.id}`}
                    className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground/0 transition-colors hover:bg-muted hover:text-muted-foreground group-hover:text-muted-foreground/60"
                    title="项目设置"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <IconSettings className="size-4" />
                  </Link>
                </div>

                <Link
                  to={`/board?project=${encodeURIComponent(p.id)}`}
                  className="flex flex-1 flex-col"
                >
                  {p.description ? (
                    <p className="mb-3 line-clamp-2 text-sm text-muted-foreground">
                      {p.description}
                    </p>
                  ) : (
                    <div className="mb-3" />
                  )}

                  {/* Repo / branch */}
                  <div className="mb-3 space-y-1">
                    <p className="flex items-center gap-1.5 break-all font-mono text-xs text-muted-foreground">
                      <IconBrandGithub className="size-3.5 shrink-0" />
                      {repoText ?? "未配置代码仓库"}
                    </p>
                    <p className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                      <IconGitBranch className="size-3.5 shrink-0" />
                      {p.defaultBranch}
                    </p>
                  </div>

                  {/* Counts */}
                  <div className="mt-auto flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-3">
                    {counts.total === 0 ? (
                      <span className="text-xs text-muted-foreground/70">
                        暂无工作项
                      </span>
                    ) : (
                      <>
                        <CountPill
                          value={counts.open}
                          label="待处理"
                          dot="bg-zinc-400"
                        />
                        <CountPill
                          value={counts.inFlight}
                          label="进行中"
                          dot="bg-blue-500"
                          spin
                        />
                        <CountPill
                          value={counts.done}
                          label="已完成"
                          dot="bg-emerald-500"
                        />
                        <span className="ml-auto font-mono text-xs text-muted-foreground/70">
                          共 {counts.total} 项
                        </span>
                      </>
                    )}
                  </div>
                </Link>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
