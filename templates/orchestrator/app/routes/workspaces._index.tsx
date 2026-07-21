import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import {
  IconDots,
  IconGitCommit,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconUpload,
} from "@tabler/icons-react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { DataTable } from "@/components/board/DataTable";
import { EmptyState } from "@/components/board/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { NewWorkspaceDialog } from "@/components/v3/NewWorkspaceDialog";
import {
  WorkspaceCommitDialog,
  type WorkspaceCommitTarget,
} from "@/components/v3/WorkspaceCommitDialog";
import { APP_TITLE } from "@/lib/app-config";

export function meta() {
  return [{ title: `${APP_TITLE} — 工作区` }];
}

const WORKSPACE_STATES = [
  "provisioning",
  "ready",
  "busy",
  "destroying",
  "destroyed",
  "error",
] as const;

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function fmtDurationAgo(iso: string | null): string {
  if (!iso) return "—";
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const s = Math.round(diff / 1000);
    if (s < 60) return `${s} 秒前`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} 分钟前`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} 小时前`;
    const d = Math.floor(h / 24);
    return `${d} 天前`;
  } catch {
    return iso;
  }
}

const STATE_COLORS: Record<string, string> = {
  provisioning:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
  ready:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400",
  busy: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  destroying:
    "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400",
  destroyed: "bg-muted text-muted-foreground",
  error: "bg-destructive/10 text-destructive",
};

interface WorkspaceItem {
  id: string;
  ownerKind: string;
  ownerId: string;
  vmName: string | null;
  repoUrl: string | null;
  branch: string | null;
  state: string;
  createdAt: string | null;
}

export default function V3WorkspacesRoute() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [ownerKindFilter, setOwnerKindFilter] = useState<string>("all");
  const [stateFilter, setStateFilter] = useState<string>("all");

  const {
    data: workspaces = [],
    isLoading,
    error,
  } = useActionQuery(
    "workspaceList" as any,
    {
      ownerKind: ownerKindFilter === "all" ? undefined : ownerKindFilter,
      state: stateFilter === "all" ? undefined : stateFilter,
    },
    undefined,
  );

  const destroyAction = useActionMutation("workspaceDestroy" as any, {});
  const [destroyingId, setDestroyingId] = useState<string | null>(null);
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);

  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [commitTarget, setCommitTarget] =
    useState<WorkspaceCommitTarget | null>(null);
  const [commitMode, setCommitMode] = useState<"commit" | "commitPush">(
    "commit",
  );

  const openCommitDialog = useCallback(
    (
      workspaceId: string,
      branch: string | null,
      mode: "commit" | "commitPush",
    ) => {
      setCommitMode(mode);
      setCommitTarget({ workspaceId, branch });
    },
    [],
  );

  // Distinct owner kinds for the filter dropdown
  const ownerKinds = useMemo(() => {
    const set = new Set<string>();
    for (const w of workspaces) {
      set.add(w.ownerKind);
    }
    return Array.from(set).sort();
  }, [workspaces]);

  const handleDestroy = useCallback((workspaceId: string) => {
    setDestroyingId(workspaceId);
    setConfirmDialogOpen(true);
  }, []);

  const confirmDestroy = useCallback(() => {
    if (!destroyingId) return;
    destroyAction.mutate(
      { workspaceId: destroyingId },
      {
        onSuccess: () => {
          setConfirmDialogOpen(false);
          setDestroyingId(null);
        },
        onError: () => {
          setConfirmDialogOpen(false);
          setDestroyingId(null);
        },
      },
    );
  }, [destroyingId, destroyAction]);

  const isFiltered = ownerKindFilter !== "all" || stateFilter !== "all";
  const hasLiveWorkspace = (state: string) =>
    state !== "destroying" && state !== "destroyed";

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            工作区
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            用于工作流派生的计算环境。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {workspaces.length > 0 ? (
            <>
              <Select
                value={ownerKindFilter}
                onValueChange={setOwnerKindFilter}
              >
                <SelectTrigger className="h-8 w-[150px]">
                  <SelectValue placeholder="所有者类型" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部所有者类型</SelectItem>
                  {ownerKinds.map((ok) => (
                    <SelectItem key={ok} value={ok}>
                      {ok}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={stateFilter} onValueChange={setStateFilter}>
                <SelectTrigger className="h-8 w-[150px]">
                  <SelectValue placeholder="状态" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部状态</SelectItem>
                  {WORKSPACE_STATES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {t(`v3.workspace.state.${s}`, { defaultValue: s })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          ) : null}
          <Button size="sm" onClick={() => setNewWorkspaceOpen(true)}>
            <IconPlus className="mr-1 size-4" />
            新建工作区
          </Button>
        </div>
      </header>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
          加载工作区失败。
        </div>
      ) : (
        <DataTable<WorkspaceItem>
          isLoading={isLoading}
          rows={workspaces}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/workspaces/${r.id}`)}
          columns={[
            {
              id: "id",
              header: "工作区 ID",
              cell: (r) => (
                <span className="font-mono text-xs font-medium">
                  {r.id.slice(0, 14)}
                </span>
              ),
            },
            {
              id: "owner",
              header: "所有者",
              cell: (r) => (
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs font-medium">{r.ownerKind}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {r.ownerId.slice(0, 12)}
                  </span>
                </div>
              ),
            },
            {
              id: "repo",
              header: "仓库",
              className: "hidden md:table-cell",
              headClassName: "hidden md:table-cell",
              cell: (r) => (
                <span
                  className="truncate text-xs text-muted-foreground"
                  title={r.repoUrl ?? undefined}
                >
                  {r.repoUrl ?? "—"}
                </span>
              ),
            },
            {
              id: "branch",
              header: "分支",
              className: "hidden md:table-cell",
              headClassName: "hidden md:table-cell",
              cell: (r) => (
                <span className="font-mono text-xs">{r.branch ?? "—"}</span>
              ),
            },
            {
              id: "state",
              header: "状态",
              cell: (r) => (
                <Badge
                  variant="secondary"
                  className={STATE_COLORS[r.state] ?? ""}
                >
                  {r.state}
                </Badge>
              ),
            },
            {
              id: "vm",
              header: "虚拟机",
              className: "hidden lg:table-cell",
              headClassName: "hidden lg:table-cell",
              cell: (r) => (
                <span className="font-mono text-xs text-muted-foreground">
                  {r.vmName ?? "—"}
                </span>
              ),
            },
            {
              id: "created",
              header: "创建时间",
              className: "hidden lg:table-cell",
              headClassName: "hidden lg:table-cell",
              cell: (r) => (
                <span className="whitespace-nowrap text-xs text-muted-foreground">
                  {fmtDate(r.createdAt)}
                  <span className="ml-1 text-muted-foreground/60">
                    ({fmtDurationAgo(r.createdAt)})
                  </span>
                </span>
              ),
            },
            {
              id: "actions",
              header: "",
              className: "text-right",
              headClassName: "text-right",
              cell: (r) => {
                if (!hasLiveWorkspace(r.state)) {
                  return (
                    <span className="text-xs text-muted-foreground">—</span>
                  );
                }
                const canCommit = r.state === "ready" || r.state === "busy";
                const destroyPending =
                  destroyAction.isPending &&
                  (
                    destroyAction.variables as
                      | { workspaceId?: string }
                      | undefined
                  )?.workspaceId === r.id;
                return (
                  <div className="flex justify-end">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="size-7 p-0"
                          aria-label="工作区操作"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <IconDots className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          disabled={!canCommit}
                          onSelect={() =>
                            openCommitDialog(r.id, r.branch, "commit")
                          }
                        >
                          <IconGitCommit className="size-4" />
                          提交
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={!canCommit}
                          onSelect={() =>
                            openCommitDialog(r.id, r.branch, "commitPush")
                          }
                        >
                          <IconUpload className="size-4" />
                          提交并推送
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          disabled={destroyPending}
                          className="text-destructive focus:bg-destructive focus:text-destructive-foreground"
                          onSelect={() => handleDestroy(r.id)}
                        >
                          <IconPlayerStop className="size-4" />
                          销毁
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                );
              },
            },
          ]}
          empty={
            <EmptyState
              icon={IconPlayerPlay}
              title={isFiltered ? "没有符合筛选条件的工作区" : "暂无工作区"}
              description={
                isFiltered
                  ? "尝试调整所有者类型或状态筛选条件。"
                  : "当派生需要计算环境时会自动创建工作区。"
              }
              className="border-0"
              action={
                isFiltered ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setOwnerKindFilter("all");
                      setStateFilter("all");
                    }}
                  >
                    清除筛选
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => setNewWorkspaceOpen(true)}>
                    <IconPlus className="mr-1 size-4" />
                    新建工作区
                  </Button>
                )
              }
            />
          }
        />
      )}

      {/* Destroy confirmation dialog */}
      <Dialog open={confirmDialogOpen} onOpenChange={setConfirmDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>销毁工作区?</DialogTitle>
            <DialogDescription>
              这会将工作区标记为正在销毁。此操作无法撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setConfirmDialogOpen(false);
                setDestroyingId(null);
              }}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDestroy}
              disabled={destroyAction.isPending}
            >
              {destroyAction.isPending ? "销毁中…" : "销毁"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* "+ New workspace" — a real modal dialog, not inline page content. */}
      <NewWorkspaceDialog
        open={newWorkspaceOpen}
        onOpenChange={setNewWorkspaceOpen}
      />

      {/* Commit / Commit + push — per-row small dialog for the commit message
          (plus PR title/body/base branch for the push variant). */}
      <WorkspaceCommitDialog
        target={commitTarget}
        mode={commitMode}
        onOpenChange={(o) => {
          if (!o) setCommitTarget(null);
        }}
      />
    </div>
  );
}
