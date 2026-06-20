import { useTranslation } from "react-i18next";
import {
  IconBug,
  IconCheckbox,
  IconDots,
  IconExternalLink,
  IconFile,
  IconFlame,
  IconGripVertical,
  IconLink,
  IconListDetails,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconTrash,
  IconX,
  type Icon,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { categoryColor, nodeStatusDot } from "@/lib/status-colors";
import { StatusBadge } from "./StatusBadge";
import { ExecBadge } from "./ExecBadge";
import { SeverityChip } from "./SeverityChip";
import { EnvTag } from "./EnvTag";
import type { WorkItem } from "@/hooks/use-work-items";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Shared work-item card (FRONTEND §2 — "What each card shows"). Reads the single
// status-colors source for the project stripe / badges. Drag is wired by the
// BOARD (native HTML5 DnD on the wrapper); this card just renders + exposes the
// ⋯ run-control menu and the click-to-open handler. The ⋯ menu drives execState
// (run/pause/cancel/enqueue/dequeue), NEVER business status (that is drag).

const TYPE_ICON: Record<string, Icon> = {
  requirement: IconListDetails,
  bug: IconBug,
  "prod-issue": IconFlame,
  task: IconCheckbox,
};

/** A node-status dot for the mini run strip (live, polled via the board query). */
export interface MiniNode {
  id: string;
  status: string;
}

export interface WorkItemCardActions {
  onOpen?: (item: WorkItem) => void;
  onRunNow?: (item: WorkItem) => void;
  onPause?: (item: WorkItem) => void;
  onCancelRun?: (item: WorkItem) => void;
  onEnqueue?: (item: WorkItem) => void;
  onDequeue?: (item: WorkItem) => void;
  onToggleBlock?: (item: WorkItem) => void;
  onCancelItem?: (item: WorkItem) => void;
  onDelete?: (item: WorkItem) => void;
  onConfirmStale?: (item: WorkItem) => void;
}

export interface WorkItemCardProps extends WorkItemCardActions {
  item: WorkItem;
  /** Project key prefix → renders "PAY-…"; falls back to the type. */
  projectKey?: string;
  /** Live mini node-run strip for a running item (optional). */
  miniNodes?: MiniNode[];
  /** Show the current stage as a sub-label (when grouped by category). */
  showStageSubLabel?: boolean;
  /** Native-DnD drag handlers wired by the board column. */
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  className?: string;
}

export function WorkItemCard({
  item,
  projectKey,
  miniNodes,
  showStageSubLabel,
  draggable,
  onDragStart,
  onDragEnd,
  className,
  onOpen,
  onRunNow,
  onPause,
  onCancelRun,
  onEnqueue,
  onDequeue,
  onToggleBlock,
  onCancelItem,
  onDelete,
  onConfirmStale,
}: WorkItemCardProps) {
  const { t } = useTranslation();
  const TypeIcon = TYPE_ICON[item.type] ?? IconCheckbox;
  const stripe = categoryColor(item.statusCategory).stripe;
  const isRunning = item.execState === "running";
  const isQueued = item.execState === "queued" || item.execState === "claimed";
  const isPaused = item.execState === "paused";
  const isIdle = item.execState === "idle";
  const deliverableLabel =
    item.deliverable?.kind === "pr"
      ? "PR"
      : item.deliverable
        ? t("board.deliverable")
        : null;

  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        "group relative flex gap-2 rounded-lg border border-border bg-card p-3 text-left shadow-sm transition-colors hover:border-foreground/20",
        draggable && "cursor-grab active:cursor-grabbing",
        className,
      )}
    >
      {/* project color stripe (category-tinted) */}
      <span
        className={cn("absolute inset-y-0 left-0 w-1 rounded-l-lg", stripe)}
        aria-hidden="true"
      />
      {draggable ? (
        <IconGripVertical
          className="mt-0.5 size-4 shrink-0 text-muted-foreground/40"
          aria-hidden="true"
        />
      ) : null}

      <div className="min-w-0 flex-1">
        {/* header row: key + type + title */}
        <button
          type="button"
          onClick={() => onOpen?.(item)}
          className="flex w-full min-w-0 items-start gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <TypeIcon
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-label={t(`wtype.${item.type}`, { defaultValue: item.type })}
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="font-mono text-[11px] text-muted-foreground">
                {projectKey ? `${projectKey}` : item.type}
              </span>
            </span>
            <span className="mt-0.5 block truncate text-sm font-medium">
              {item.title}
            </span>
          </span>
        </button>

        {/* badge row: status / exec / severity / env / blocked */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {showStageSubLabel ? (
            <StatusBadge status={item.status} category={item.statusCategory} />
          ) : null}
          {!isIdle ? <ExecBadge state={item.execState} hideIdle /> : null}
          {item.severity ? <SeverityChip severity={item.severity} /> : null}
          {item.environment ? <EnvTag env={item.environment} /> : null}
          {item.blocked ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-600 ring-1 ring-inset ring-red-500/30 dark:text-red-400">
                  <IconX className="size-3" />
                  {t("board.blocked")}
                </span>
              </TooltipTrigger>
              {item.blockedReason ? (
                <TooltipContent>{item.blockedReason}</TooltipContent>
              ) : null}
            </Tooltip>
          ) : null}
          {item.priority < 0 ? (
            <span className="inline-flex items-center rounded-full bg-orange-500/15 px-2 py-0.5 text-[10px] font-semibold text-orange-600 ring-1 ring-inset ring-orange-500/30 dark:text-orange-400">
              {t("priority.p0")}
            </span>
          ) : null}
        </div>

        {/* stale watchdog flag */}
        {item.statusStale ? (
          <button
            type="button"
            onClick={() => onConfirmStale?.(item)}
            className="mt-2 flex w-full items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1 text-left text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-500/30 hover:bg-amber-500/20 dark:text-amber-300"
          >
            {t("board.stale")}
          </button>
        ) : null}

        {/* mini node-run strip (running cards) */}
        {isRunning && miniNodes && miniNodes.length > 0 ? (
          <div
            className="mt-2 flex items-center gap-1"
            aria-label={t("board.miniNodes")}
          >
            {miniNodes.slice(0, 14).map((n) => (
              <span
                key={n.id}
                className={cn("size-1.5 rounded-full", nodeStatusDot(n.status))}
              />
            ))}
          </div>
        ) : null}

        {/* deliverable chip */}
        {deliverableLabel ? (
          <div className="mt-2">
            <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-500/30 dark:text-emerald-300">
              {item.deliverable?.kind === "pr" ? (
                <IconExternalLink className="size-3" />
              ) : (
                <IconFile className="size-3" />
              )}
              {deliverableLabel}
            </span>
          </div>
        ) : null}
      </div>

      {/* ⋯ run-control menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t("board.openItem")}
            className="absolute right-1 top-1 flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 data-[state=open]:opacity-100"
          >
            <IconDots className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => onOpen?.(item)}>
            <IconExternalLink className="size-4" />
            {t("board.openItem")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {isIdle || item.execState === "failed" || item.execState === "done" ? (
            <DropdownMenuItem onSelect={() => onEnqueue?.(item)}>
              <IconPlus className="size-4" />
              {t("board.enqueueOne")}
            </DropdownMenuItem>
          ) : null}
          {isQueued ? (
            <DropdownMenuItem onSelect={() => onDequeue?.(item)}>
              <IconX className="size-4" />
              {t("board.dequeue")}
            </DropdownMenuItem>
          ) : null}
          {!isRunning && !isPaused ? (
            <DropdownMenuItem onSelect={() => onRunNow?.(item)}>
              <IconPlayerPlay className="size-4" />
              {t("board.runNow")}
            </DropdownMenuItem>
          ) : null}
          {isRunning ? (
            <DropdownMenuItem onSelect={() => onPause?.(item)}>
              <IconPlayerPause className="size-4" />
              {t("board.pauseRun")}
            </DropdownMenuItem>
          ) : null}
          {isRunning || isPaused ? (
            <DropdownMenuItem onSelect={() => onCancelRun?.(item)}>
              <IconX className="size-4" />
              {t("board.cancelRun")}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onToggleBlock?.(item)}>
            <IconLink className="size-4" />
            {item.blocked ? t("board.unblock") : t("board.block")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onCancelItem?.(item)}>
            <IconX className="size-4" />
            {t("board.cancelItem")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:bg-destructive focus:text-destructive-foreground"
            onSelect={() => onDelete?.(item)}
          >
            <IconTrash className="size-4" />
            {t("board.deleteItem")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
