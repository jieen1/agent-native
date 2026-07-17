import type { WorkItem } from "@shared/types";
import {
  IconChevronRight,
  IconCornerRightDown,
  IconGripVertical,
  IconInbox,
} from "@tabler/icons-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useUpdateSprint, useUpdateWorkItem } from "@/hooks/use-tracker";
import { cn } from "@/lib/utils";

const PRIORITY_BADGE: Record<
  number,
  { label: string; variant: "destructive" | "secondary" | "outline" }
> = {
  1: { label: "P0", variant: "destructive" },
  2: { label: "P1", variant: "destructive" },
  3: { label: "P2", variant: "secondary" },
  4: { label: "P3", variant: "outline" },
};

function daysObserved(createdAt: string): number {
  const ms = Date.now() - new Date(createdAt).getTime();
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

/**
 * Bottom collapsible "问题池" lane (s2-sprint-studio.html `.problem-pool`) —
 * project backlog work items with no sprint assigned yet, sorted by
 * priority. Drag or click "挂载" to attach to this sprint
 * (`update-work-item({sprintId})`, which also logs a `sprint.attach`
 * activity — see actions/update-work-item.ts).
 */
export function ProblemPoolDrawer({
  sprintId,
  backlogItems,
  defaultOpen,
  onOpenChange,
}: {
  sprintId: string;
  backlogItems: WorkItem[];
  defaultOpen: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const updateWorkItem = useUpdateWorkItem();
  const updateSprint = useUpdateSprint();

  const sorted = [...backlogItems].sort((a, b) => a.priority - b.priority);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    onOpenChange?.(next);
    void updateSprint.mutateAsync({
      id: sprintId,
      studioState: { problemPoolCollapsed: !next },
    });
  }

  function attach(itemId: string) {
    updateWorkItem.mutate({ id: itemId, sprintId });
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={handleOpenChange}
      className="mx-5 mb-4 shrink-0 overflow-hidden rounded-md border border-border"
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 bg-muted/40 px-3.5 py-2 text-left transition-transform hover:-translate-y-px"
        >
          <IconChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          <IconInbox className="size-4 text-muted-foreground" />
          <span className="text-[12.5px] font-semibold">问题池</span>
          <span className="text-[11px] text-muted-foreground">
            项目 backlog 中未挂本 sprint 的观察项
          </span>
          <Badge variant="secondary" className="ml-auto">
            {sorted.length} 项
          </Badge>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-1.5 border-t border-border p-2.5">
        {sorted.length === 0 ? (
          <p className="px-1 py-1 text-xs text-muted-foreground">
            backlog 中暂无未挂 sprint 的观察项。
          </p>
        ) : (
          sorted.map((item) => {
            const badge = PRIORITY_BADGE[item.priority] ?? PRIORITY_BADGE[4]!;
            return (
              <div
                key={item.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/tracker-work-item-id", item.id);
                }}
                className="flex cursor-grab items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 transition-transform hover:-translate-y-px"
              >
                <IconGripVertical className="size-3.5 shrink-0 text-muted-foreground" />
                <Badge
                  variant={badge.variant}
                  className="h-4.5 px-1 text-[9.5px]"
                >
                  {badge.label}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-[12.5px]">
                  {item.itemKeyDisplay ?? item.itemKey} · {item.title}
                </span>
                <span className="rounded-full border border-border px-2 py-0.5 text-[10.5px] text-muted-foreground">
                  观察 {daysObserved(item.createdAt)} 天
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 gap-1 px-1.5 text-[11.5px]"
                  title="拖入上方场景区，或点击直接挂载本 sprint（写 sprintId，落活动流）"
                  onClick={() => attach(item.id)}
                >
                  <IconCornerRightDown className="size-3.5" />
                  挂载
                </Button>
              </div>
            );
          })
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
