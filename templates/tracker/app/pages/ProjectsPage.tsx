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
        className={cn(
          "size-1.5 rounded-full",
          dot,
          spin && "animate-pulse",
        )}
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
      (map.get(it.projectId) ?? map.set(it.projectId, []).get(it.projectId)!).push(
        it,
      );
    }
    return map;
  }, [items]);

  return (
    <div className="mx-auto max-w-5xl p-5 sm:p-6">
      {/* ── Header ── */}
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Projects</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Configure a repo and default branch once per project. Work items
            inherit that context when dispatched.
          </p>
        </div>
        <NewProjectDialog>
          <Button size="sm" className="gap-1.5">
            <IconPlus className="size-4" />
            New project
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
          <p className="text-sm font-medium">No projects yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Create your first project to configure its repo and start adding work
            items.
          </p>
          <NewProjectDialog>
            <Button className="mt-1 gap-1.5">
              <IconPlus className="size-4" />
              New project
            </Button>
          </NewProjectDialog>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {projects.map((p) => {
            const counts = countFor(countsByProject.get(p.id) ?? []);
            const repoText = repoLabel(p.gitRemote);
            return (
              <Link
                key={p.id}
                to={`/board?project=${encodeURIComponent(p.id)}`}
                className="group flex h-full flex-col rounded-xl border border-border bg-card p-4 shadow-sm transition-all hover:border-foreground/20 hover:shadow"
              >
                {/* Title */}
                <div className="mb-2 flex items-start gap-2">
                  <span className="inline-flex h-5 shrink-0 items-center rounded bg-muted px-1.5 font-mono text-[11px] font-semibold text-muted-foreground">
                    {p.key}
                  </span>
                  <h3 className="min-w-0 flex-1 truncate text-base font-semibold leading-6 text-foreground">
                    {p.name}
                  </h3>
                  <IconArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground" />
                </div>

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
                    {repoText ?? "no repo configured"}
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
                      No work items yet
                    </span>
                  ) : (
                    <>
                      <CountPill
                        value={counts.open}
                        label="open"
                        dot="bg-zinc-400"
                      />
                      <CountPill
                        value={counts.inFlight}
                        label="in flight"
                        dot="bg-blue-500"
                        spin
                      />
                      <CountPill
                        value={counts.done}
                        label="done"
                        dot="bg-emerald-500"
                      />
                      <span className="ml-auto font-mono text-xs text-muted-foreground/70">
                        {counts.total} total
                      </span>
                    </>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
