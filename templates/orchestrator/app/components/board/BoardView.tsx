import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import {
  IconLayoutKanban,
  IconListCheck,
  IconPlus,
  IconStack2,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { categoryColor, execColor } from "@/lib/status-colors";
import {
  useDeleteWorkItem,
  useTransitionWorkItem,
  type WorkItem,
  type WorkItemType,
} from "@/hooks/use-work-items";
import { useQueueControls } from "@/hooks/use-queue";
import type { ProjectDetail } from "@/hooks/use-projects";
import type { TemplateListItem } from "@/hooks/use-templates";
import { WorkItemCard } from "./WorkItemCard";
import { EmptyState } from "./EmptyState";
import { ConfirmDialog } from "./ConfirmDialog";
import { ApprovalBanner } from "./ApprovalBanner";
import { WorkItemDialog } from "@/components/dialogs/WorkItemDialog";
import { EnqueueDialog } from "@/components/dialogs/EnqueueDialog";
import {
  EXEC_LANES,
  categoryColumns,
  firstStageOfCategory,
  groupByColumn,
  groupByExec,
  stageColumns,
  type BoardColumn,
} from "./board-columns";

// The Board kanban (FRONTEND §2). Two views (Board by business status / Queue by
// execState), a filter bar, drag→transition-work-item (optimistic + rollback via
// the transition hook; illegal drops snap back), and ⋯ run controls (execState
// only). Reusable: the route passes all-projects, the project-detail page passes
// one project + its scheme.

type ViewMode = "board" | "queue";

export interface BoardViewProps {
  items: WorkItem[];
  isLoading: boolean;
  error?: unknown;
  /** When scoped to one project, its resolved scheme set + key prefix. */
  project?: ProjectDetail | null;
  /** Resolved scheme set per project id (all-projects board). */
  schemesByProject?: Record<string, ProjectDetail["schemes"]>;
  /** Project key prefix per project id (all-projects board). */
  keyByProject?: Record<string, string>;
  workflows?: TemplateListItem[];
  concurrencyDegree?: number;
}

export function BoardView({
  items,
  isLoading,
  error,
  project,
  schemesByProject,
  keyByProject,
  workflows = [],
  concurrencyDegree = 1,
}: BoardViewProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const transition = useTransitionWorkItem();
  const deleteItem = useDeleteWorkItem();
  const { enqueue, dequeue, runStart, runPause, runCancel } =
    useQueueControls();

  const [view, setView] = useState<ViewMode>("board");
  const [typeFilter, setTypeFilter] = useState<WorkItemType | "all">("all");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [newItemOpen, setNewItemOpen] = useState(false);
  const [enqueueOpen, setEnqueueOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<WorkItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkItem | null>(null);
  const [cancelRunTarget, setCancelRunTarget] = useState<WorkItem | null>(null);

  // ── resolve the scheme set used to derive columns/targets ──────────────────
  function schemesFor(item: WorkItem): ProjectDetail["schemes"] | undefined {
    if (project) return project.schemes;
    return schemesByProject?.[item.projectId];
  }
  function projectKeyOf(item: WorkItem): string | undefined {
    if (project) return project.key;
    return keyByProject?.[item.projectId];
  }

  // ── filter bar ─────────────────────────────────────────────────────────────
  const assignees = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) if (i.assignee) set.add(i.assignee);
    return Array.from(set).sort();
  }, [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((i) => {
      if (typeFilter !== "all" && i.type !== typeFilter) return false;
      if (assigneeFilter !== "all" && i.assignee !== assigneeFilter)
        return false;
      if (q && !i.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, typeFilter, assigneeFilter, search]);

  // ── columns ─────────────────────────────────────────────────────────────────
  const columns: BoardColumn[] = useMemo(() => {
    if (typeFilter !== "all") {
      // One type → the scheme's full pipeline. Use the scoped project's scheme,
      // or the first project's scheme on the all-projects board.
      const scheme =
        project?.schemes?.[typeFilter] ??
        (schemesByProject
          ? Object.values(schemesByProject)[0]?.[typeFilter]
          : undefined);
      if (scheme) return stageColumns(scheme);
    }
    return categoryColumns();
  }, [typeFilter, project, schemesByProject]);

  const grouped = useMemo(
    () => groupByColumn(filtered, columns),
    [filtered, columns],
  );
  const lanes = useMemo(() => groupByExec(filtered), [filtered]);

  // ── drag → transition (the human business-status move) ──────────────────────
  // The dropped card lives in a DIFFERENT column, so resolve it from the full
  // filtered list by the id carried in the drag payload.
  function handleDropId(id: string, column: BoardColumn) {
    const item = filtered.find((i) => i.id === id);
    if (!item) return;
    handleDrop(item, column);
  }

  function handleDrop(item: WorkItem, column: BoardColumn) {
    const scheme = schemesFor(item)?.[item.type];
    if (!scheme) {
      toast.error(t("common.actionFailed"));
      return;
    }
    // Resolve the concrete target stage: stage columns carry it; category columns
    // map to that category's first non-terminal stage.
    const targetStage = column.byCategory
      ? firstStageOfCategory(scheme, column.category)
      : column.targetStage;
    if (!targetStage || targetStage === item.status) return;

    transition.mutate(
      {
        id: item.id,
        toStatus: targetStage,
        optimisticCategory: column.category,
      },
      {
        onSuccess: () =>
          toast.success(t("board.movedTo", { status: targetStage })),
        onError: (e: unknown) =>
          toast.error(
            e instanceof Error ? e.message : t("board.transitionFailed"),
          ),
      },
    );
  }

  // ── ⋯ menu run controls (execState only) ────────────────────────────────────
  const cardActions = {
    onOpen: (i: WorkItem) => navigate(`/items/${i.id}`),
    onRunNow: (i: WorkItem) =>
      runStart.mutate(
        { workItemId: i.id, wait: false },
        {
          onSuccess: () => toast.success(t("board.runStarted")),
          onError: onActionError,
        },
      ),
    onPause: (i: WorkItem) => {
      if (!i.workflowRunId) return;
      runPause.mutate(
        { runId: i.workflowRunId },
        {
          onSuccess: () => toast.success(t("board.runPaused")),
          onError: onActionError,
        },
      );
    },
    onCancelRun: (i: WorkItem) => setCancelRunTarget(i),
    onEnqueue: (i: WorkItem) =>
      enqueue.mutate(
        { id: i.id },
        {
          onSuccess: () => toast.success(t("board.enqueued")),
          onError: onActionError,
        },
      ),
    onDequeue: (i: WorkItem) =>
      dequeue.mutate(
        { id: i.id },
        {
          onSuccess: () => toast.success(t("board.dequeued")),
          onError: onActionError,
        },
      ),
    onToggleBlock: (i: WorkItem) =>
      // A same-stage overlay write: transition-work-item recognizes toStatus ===
      // current status as a blocked-only overlay update (no business move).
      transition.mutate(
        { id: i.id, toStatus: i.status, blocked: !i.blocked },
        {
          onSuccess: () => toast.success(t("board.blockedToggled")),
          onError: onActionError,
        },
      ),
    onCancelItem: (i: WorkItem) => setCancelTarget(i),
    onDelete: (i: WorkItem) => setDeleteTarget(i),
    onConfirmStale: (i: WorkItem) => navigate(`/items/${i.id}`),
  };

  function onActionError(e: unknown) {
    toast.error(e instanceof Error ? e.message : t("common.actionFailed"));
  }

  function confirmCancelItem() {
    if (!cancelTarget) return;
    const scheme = schemesFor(cancelTarget)?.[cancelTarget.type];
    const cancelStage = scheme?.stages.find(
      (s) => s.category === "cancelled",
    )?.key;
    if (!cancelStage) {
      toast.error(t("common.actionFailed"));
      setCancelTarget(null);
      return;
    }
    transition.mutate(
      {
        id: cancelTarget.id,
        toStatus: cancelStage,
        optimisticCategory: "cancelled",
        resolution: "cancelled",
      },
      {
        onSuccess: () => {
          setCancelTarget(null);
          toast.success(t("board.movedTo", { status: cancelStage }));
        },
        onError: (e: unknown) => {
          setCancelTarget(null);
          onActionError(e);
        },
      },
    );
  }

  function confirmDeleteItem() {
    if (!deleteTarget) return;
    deleteItem.mutate(
      { id: deleteTarget.id },
      {
        onSuccess: () => {
          setDeleteTarget(null);
          toast.success(t("common.deleted"));
        },
        onError: (e: unknown) => {
          setDeleteTarget(null);
          onActionError(e);
        },
      },
    );
  }

  function confirmCancelRun() {
    if (!cancelRunTarget?.workflowRunId) {
      setCancelRunTarget(null);
      return;
    }
    runCancel.mutate(
      { runId: cancelRunTarget.workflowRunId },
      {
        onSuccess: () => {
          setCancelRunTarget(null);
          toast.success(t("board.runCancelled"));
        },
        onError: (e: unknown) => {
          setCancelRunTarget(null);
          onActionError(e);
        },
      },
    );
  }

  const showEmpty = !isLoading && !error && items.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── toolbar: view toggle + filters + actions ── */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <ToggleGroup
          type="single"
          value={view}
          onValueChange={(v) => v && setView(v as ViewMode)}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="board" aria-label={t("board.viewBoard")}>
            <IconLayoutKanban className="size-4" />
            {t("board.viewBoard")}
          </ToggleGroupItem>
          <ToggleGroupItem value="queue" aria-label={t("board.viewQueue")}>
            <IconStack2 className="size-4" />
            {t("board.viewQueue")}
          </ToggleGroupItem>
        </ToggleGroup>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select
            value={typeFilter}
            onValueChange={(v) => setTypeFilter(v as WorkItemType | "all")}
          >
            <SelectTrigger className="h-8 w-[130px]">
              <SelectValue placeholder={t("board.allTypes")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("board.allTypes")}</SelectItem>
              <SelectItem value="requirement">
                {t("wtype.requirement")}
              </SelectItem>
              <SelectItem value="bug">{t("wtype.bug")}</SelectItem>
              <SelectItem value="prod-issue">
                {t("wtype.prod-issue")}
              </SelectItem>
              <SelectItem value="task">{t("wtype.task")}</SelectItem>
            </SelectContent>
          </Select>

          {assignees.length > 0 ? (
            <Select value={assigneeFilter} onValueChange={setAssigneeFilter}>
              <SelectTrigger className="h-8 w-[140px]">
                <SelectValue placeholder={t("board.allAssignees")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("board.allAssignees")}</SelectItem>
                {assignees.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}

          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("board.searchPlaceholder")}
            className="h-8 w-[180px]"
          />

          <Button
            size="sm"
            variant="outline"
            onClick={() => setEnqueueOpen(true)}
          >
            <IconListCheck className="size-4" />
            {t("board.enqueue")}
          </Button>
          <Button size="sm" onClick={() => setNewItemOpen(true)}>
            <IconPlus className="size-4" />
            {t("board.newWorkItem")}
          </Button>
        </div>
      </div>

      {/* ── human-approval surfacing (running items parked at a gate) ── */}
      {!showEmpty && !error ? <ApprovalBanner items={filtered} /> : null}

      {/* ── body ── */}
      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
          {t("common.loadError")}
        </div>
      ) : showEmpty ? (
        <EmptyState
          icon={IconLayoutKanban}
          title={t("board.emptyTitle")}
          description={t("board.emptyDescription")}
          action={
            <Button size="sm" onClick={() => setNewItemOpen(true)}>
              <IconPlus className="size-4" />
              {t("board.newWorkItem")}
            </Button>
          }
        />
      ) : view === "board" ? (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
          {columns.map((col) => (
            <BoardColumnView
              key={col.id}
              column={col}
              items={grouped.get(col.id) ?? []}
              isLoading={isLoading}
              labelFor={(c) =>
                c.byCategory
                  ? t(`category.${c.category}`)
                  : t(`status.${c.targetStage}`, {
                      defaultValue: c.targetStage,
                    })
              }
              onDropId={handleDropId}
              projectKeyOf={projectKeyOf}
              showStageSubLabel={col.byCategory}
              cardActions={cardActions}
            />
          ))}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
          {EXEC_LANES.map((lane) => (
            <QueueLaneView
              key={lane}
              lane={lane}
              label={t(`exec.${lane}`)}
              items={lanes.get(lane) ?? []}
              projectKeyOf={projectKeyOf}
              cardActions={cardActions}
            />
          ))}
        </div>
      )}

      {/* ── dialogs ── */}
      <WorkItemDialog
        open={newItemOpen}
        onOpenChange={setNewItemOpen}
        projectId={project?.id}
        workflows={workflows}
      />
      <EnqueueDialog
        open={enqueueOpen}
        onOpenChange={setEnqueueOpen}
        items={filtered}
        workflows={workflows}
        currentConcurrency={concurrencyDegree}
        projectKeyOf={projectKeyOf}
      />
      <ConfirmDialog
        open={!!cancelTarget}
        onOpenChange={(o) => !o && setCancelTarget(null)}
        title={t("dialog.cancelItemTitle")}
        description={t("dialog.cancelItemBody")}
        confirmLabel={t("board.cancelItem")}
        pending={transition.isPending}
        onConfirm={confirmCancelItem}
      />
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={t("dialog.deleteItemTitle")}
        description={t("dialog.deleteItemBody")}
        pending={deleteItem.isPending}
        onConfirm={confirmDeleteItem}
      />
      <ConfirmDialog
        open={!!cancelRunTarget}
        onOpenChange={(o) => !o && setCancelRunTarget(null)}
        title={t("dialog.cancelRunTitle")}
        description={t("dialog.cancelRunBody")}
        confirmLabel={t("board.cancelRun")}
        pending={runCancel.isPending}
        onConfirm={confirmCancelRun}
      />
    </div>
  );
}

// ── a single board column (a drop target) ────────────────────────────────────
interface CardActionsBag {
  onOpen: (i: WorkItem) => void;
  onRunNow: (i: WorkItem) => void;
  onPause: (i: WorkItem) => void;
  onCancelRun: (i: WorkItem) => void;
  onEnqueue: (i: WorkItem) => void;
  onDequeue: (i: WorkItem) => void;
  onToggleBlock: (i: WorkItem) => void;
  onCancelItem: (i: WorkItem) => void;
  onDelete: (i: WorkItem) => void;
  onConfirmStale: (i: WorkItem) => void;
}

function BoardColumnView({
  column,
  items,
  isLoading,
  labelFor,
  onDropId,
  projectKeyOf,
  showStageSubLabel,
  cardActions,
}: {
  column: BoardColumn;
  items: WorkItem[];
  isLoading: boolean;
  labelFor: (c: BoardColumn) => string;
  onDropId: (id: string, column: BoardColumn) => void;
  projectKeyOf: (item: WorkItem) => string | undefined;
  showStageSubLabel: boolean;
  cardActions: CardActionsBag;
}) {
  const { t } = useTranslation();
  const [isOver, setIsOver] = useState(false);
  const color = categoryColor(column.category);

  return (
    <section
      onDragOver={(e) => {
        e.preventDefault();
        if (!isOver) setIsOver(true);
      }}
      onDragLeave={() => setIsOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsOver(false);
        const id = e.dataTransfer.getData("text/work-item");
        if (id) onDropId(id, column);
      }}
      className={cn(
        "flex w-72 shrink-0 flex-col rounded-lg border border-border bg-muted/20 transition-colors",
        isOver && "border-foreground/30 bg-accent/40 ring-2 ring-ring/40",
      )}
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs font-semibold",
            color.column,
          )}
        >
          {labelFor(column)}
        </span>
        <span className="text-xs text-muted-foreground">{items.length}</span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {isLoading ? (
          <CardSkeletons />
        ) : items.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground">
            {t("board.emptyColumn")}
          </p>
        ) : (
          items.map((item) => (
            <WorkItemCard
              key={item.id}
              item={item}
              projectKey={projectKeyOf(item)}
              showStageSubLabel={showStageSubLabel}
              draggable
              onDragStart={(e) =>
                e.dataTransfer.setData("text/work-item", item.id)
              }
              {...cardActions}
            />
          ))
        )}
      </div>
    </section>
  );
}

// ── a single queue lane (execState, read-only — no drag) ─────────────────────
function QueueLaneView({
  lane,
  label,
  items,
  projectKeyOf,
  cardActions,
}: {
  lane: string;
  label: string;
  items: WorkItem[];
  projectKeyOf: (item: WorkItem) => string | undefined;
  cardActions: CardActionsBag;
}) {
  const { t } = useTranslation();
  const color = execColor(lane);
  return (
    <section className="flex w-72 shrink-0 flex-col rounded-lg border border-border bg-muted/20">
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs font-semibold",
            color.column,
          )}
        >
          {label}
        </span>
        <span className="text-xs text-muted-foreground">{items.length}</span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {items.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground">
            {t("board.queueLaneEmpty")}
          </p>
        ) : (
          items.map((item) => (
            <WorkItemCard
              key={item.id}
              item={item}
              projectKey={projectKeyOf(item)}
              showStageSubLabel
              {...cardActions}
            />
          ))
        )}
      </div>
    </section>
  );
}

function CardSkeletons() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-20 animate-pulse rounded-lg border border-border bg-muted/40"
        />
      ))}
    </>
  );
}
