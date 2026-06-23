import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import {
  IconPlayerPlay,
  IconPlayerStop,
} from "@tabler/icons-react";
import { APP_TITLE } from "@/lib/app-config";
import { DataTable } from "@/components/board/DataTable";
import { EmptyState } from "@/components/board/EmptyState";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function meta() {
  return [{ title: `${APP_TITLE} — V3 Workspaces` }];
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
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  } catch {
    return iso;
  }
}

const STATE_COLORS: Record<string, string> = {
  provisioning: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
  ready: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400",
  busy: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  destroying: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400",
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
    { ownerKind: ownerKindFilter === "all" ? undefined : ownerKindFilter, state: stateFilter === "all" ? undefined : stateFilter },
    undefined,
  );

  const destroyAction = useActionMutation("workspaceDestroy" as any, {});
  const navAction = useActionMutation("navigate" as any, {});
  const [destroyingId, setDestroyingId] = useState<string | null>(null);
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);

  useEffect(() => {
    navAction.mutate({ view: "v3_workspaces" as any });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Distinct owner kinds for the filter dropdown
  const ownerKinds = useMemo(() => {
    const set = new Set<string>();
    for (const w of workspaces) {
      set.add(w.ownerKind);
    }
    return Array.from(set).sort();
  }, [workspaces]);

  const handleDestroy = useCallback(
    (workspaceId: string) => {
      setDestroyingId(workspaceId);
      setConfirmDialogOpen(true);
    },
    [],
  );

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
            V3 Workspaces
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Compute environments for V3 workflow spawns.
          </p>
        </div>
        {workspaces.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <Select value={ownerKindFilter} onValueChange={setOwnerKindFilter}>
              <SelectTrigger className="h-8 w-[150px]">
                <SelectValue placeholder="Owner kind" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All owner kinds</SelectItem>
                {ownerKinds.map((ok) => (
                  <SelectItem key={ok} value={ok}>
                    {ok}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={stateFilter} onValueChange={setStateFilter}>
              <SelectTrigger className="h-8 w-[150px]">
                <SelectValue placeholder="State" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All states</SelectItem>
                {WORKSPACE_STATES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(`v3.workspace.state.${s}`, { defaultValue: s })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </header>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
          Failed to load workspaces.
        </div>
      ) : (
        <DataTable<WorkspaceItem>
          isLoading={isLoading}
          rows={workspaces}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/v3/workspaces/${r.id}`)}
          columns={[
            {
              id: "id",
              header: "Workspace ID",
              cell: (r) => (
                <span className="font-mono text-xs font-medium">
                  {r.id.slice(0, 14)}
                </span>
              ),
            },
            {
              id: "owner",
              header: "Owner",
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
              header: "Repo",
              className: "hidden md:table-cell",
              headClassName: "hidden md:table-cell",
              cell: (r) => (
                <span className="truncate text-xs text-muted-foreground" title={r.repoUrl ?? undefined}>
                  {r.repoUrl ?? "—"}
                </span>
              ),
            },
            {
              id: "branch",
              header: "Branch",
              className: "hidden md:table-cell",
              headClassName: "hidden md:table-cell",
              cell: (r) => (
                <span className="font-mono text-xs">
                  {r.branch ?? "—"}
                </span>
              ),
            },
            {
              id: "state",
              header: "State",
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
              header: "VM",
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
              header: "Created",
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
              cell: (r) => {
                if (!hasLiveWorkspace(r.state)) return null;
                return (
                  <Button
                    size="sm"
                    variant="destructive"
                    className="h-6 px-2 text-xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDestroy(r.id);
                    }}
                    disabled={destroyAction.isPending}
                  >
                    <IconPlayerStop className="mr-1 size-3" />
                    Destroy
                  </Button>
                );
              },
            },
          ]}
          empty={
            <EmptyState
              icon={IconPlayerPlay}
              title={
                isFiltered ? "No workspaces match filters" : "No workspaces yet"
              }
              description={
                isFiltered
                  ? "Try adjusting the owner kind or state filter."
                  : "Workspaces are created when V3 spawns require a compute environment."
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
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          }
        />
      )}

      {/* Destroy confirmation dialog */}
      <Dialog open={confirmDialogOpen} onOpenChange={setConfirmDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Destroy workspace?</DialogTitle>
            <DialogDescription>
              This will mark the workspace as destroying. This action cannot be
              undone.
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
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDestroy}
              disabled={destroyAction.isPending}
            >
              {destroyAction.isPending ? "Destroying…" : "Destroy"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
