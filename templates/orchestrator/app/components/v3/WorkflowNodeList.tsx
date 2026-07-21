import {
  IconGripVertical,
  IconPlus,
  IconTrash,
  IconChevronDown,
} from "@tabler/icons-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import {
  NODE_TYPES,
  NODE_TYPE_LABEL,
  type WorkflowNode,
  type WorkflowNodeType,
} from "./workflow-dag-types";
import { NodeTypeDot } from "./WorkflowNodeTypeIcon";

export interface WorkflowNodeListProps {
  nodes: WorkflowNode[];
  selectedNodeId: string | null;
  errorsByNode: Record<string, string[]>;
  onSelectNode: (nodeId: string) => void;
  onDeleteNode: (nodeId: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onAddNode: (type: WorkflowNodeType) => void;
}

/** Left column: ordered, drag-reorderable node list + "add node" menu. */
export function WorkflowNodeList({
  nodes,
  selectedNodeId,
  errorsByNode,
  onSelectNode,
  onDeleteNode,
  onReorder,
  onAddNode,
}: WorkflowNodeListProps) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        节点 ({nodes.length})
      </div>

      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        {nodes.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
            暂无节点
          </div>
        ) : (
          nodes.map((node, index) => {
            const selected = node.id === selectedNodeId;
            const nodeErrors = errorsByNode[node.id] ?? [];
            const hasError = nodeErrors.length > 0;
            return (
              <div
                key={node.id}
                draggable
                onDragStart={() => setDragIndex(index)}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (overIndex !== index) setOverIndex(index);
                }}
                onDragEnd={() => {
                  setDragIndex(null);
                  setOverIndex(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragIndex !== null && dragIndex !== index) {
                    onReorder(dragIndex, index);
                  }
                  setDragIndex(null);
                  setOverIndex(null);
                }}
                onClick={() => onSelectNode(node.id)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md border border-transparent px-2 py-2 transition-colors",
                  selected ? "border-border bg-accent" : "hover:bg-muted/60",
                  hasError && !selected && "border-destructive/50",
                  overIndex === index &&
                    dragIndex !== null &&
                    dragIndex !== index
                    ? "border-dashed border-ring"
                    : "",
                )}
              >
                <IconGripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground/50" />
                <NodeTypeDot type={node.type} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{node.id}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {node.type}
                  </div>
                  {hasError ? (
                    <div className="truncate text-[10.5px] text-destructive">
                      {nodeErrors[0]}
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  aria-label="删除节点"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteNode(node.id);
                  }}
                  className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <IconTrash className="size-3.5" />
                </button>
              </div>
            );
          })
        )}
      </div>

      <div className="shrink-0 border-t border-border p-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-between"
            >
              <span className="flex items-center gap-1.5">
                <IconPlus className="size-3.5" />
                添加节点
              </span>
              <IconChevronDown className="size-3.5 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            {NODE_TYPES.map((type) => (
              <DropdownMenuItem
                key={type}
                onSelect={() => onAddNode(type)}
                className="gap-2"
              >
                <NodeTypeDot type={type} size="sm" />
                {NODE_TYPE_LABEL[type]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
