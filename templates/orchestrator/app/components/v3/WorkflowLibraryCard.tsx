import {
  IconCopy,
  IconDots,
  IconEye,
  IconPlayerPlay,
  IconTrash,
} from "@tabler/icons-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import type { WorkflowListRow } from "./workflow-library-types";
import { WorkflowDagThumbnail } from "./WorkflowDagThumbnail";

export interface WorkflowLibraryCardProps {
  row: WorkflowListRow;
  selected: boolean;
  duplicating: boolean;
  onSelect: () => void;
  onView: () => void;
  onRun: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

export function WorkflowLibraryCard({
  row,
  selected,
  duplicating,
  onSelect,
  onView,
  onRun,
  onDuplicate,
  onDelete,
}: WorkflowLibraryCardProps) {
  const nodes = row.dag?.nodes ?? [];

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect();
      }}
      className={cn(
        "group relative flex cursor-pointer flex-col gap-2 rounded-lg border bg-card p-3 text-left transition-colors",
        selected
          ? "border-primary ring-1 ring-primary"
          : "border-border hover:border-foreground/30",
      )}
    >
      <div
        className={cn(
          "absolute right-2.5 top-2.5 hidden items-center gap-0.5 rounded-md border bg-card p-0.5 shadow-sm group-hover:flex",
        )}
      >
        <Button
          size="sm"
          variant="ghost"
          className="size-6 p-0"
          title="查看"
          onClick={(e) => {
            e.stopPropagation();
            onView();
          }}
        >
          <IconEye className="size-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="size-6 p-0"
          title="新建 run"
          onClick={(e) => {
            e.stopPropagation();
            onRun();
          }}
        >
          <IconPlayerPlay className="size-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="size-6 p-0"
          title="复制"
          disabled={duplicating}
          onClick={(e) => {
            e.stopPropagation();
            onDuplicate();
          }}
        >
          <IconCopy className="size-3.5" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="size-6 p-0"
              title="更多"
              onClick={(e) => e.stopPropagation()}
            >
              <IconDots className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={onDelete}
            >
              <IconTrash className="mr-1.5 size-3.5" />
              删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 pr-16">
        <span className="truncate font-mono text-[13px] font-semibold">
          {row.name}
        </span>
        <Badge variant="secondary" className="font-mono text-[10.5px]">
          v{row.version}
        </Badge>
        {row.meta.builtin ? (
          <Badge
            variant="outline"
            className="border-brand/40 bg-brand/5 text-[10.5px] text-brand"
          >
            内置
          </Badge>
        ) : null}
      </div>

      <WorkflowDagThumbnail nodes={nodes} />

      <p className="line-clamp-2 min-h-[2.4em] text-xs text-muted-foreground">
        {row.description || "—"}
      </p>

      <div className="flex items-center gap-2.5 font-mono text-[11px] text-muted-foreground">
        <span>近 30 天 run {row.stats.runCount}</span>
        <span>
          成功率{" "}
          {row.stats.successRate === null ? "—" : `${row.stats.successRate}%`}
        </span>
      </div>

      {row.meta.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {row.meta.tags.map((tag) => (
            <Badge
              key={tag}
              variant="outline"
              className="rounded-full text-[11px] font-normal text-muted-foreground"
            >
              {tag}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}
