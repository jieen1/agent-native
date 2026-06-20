import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import { NODE_TYPE_META } from "@/lib/node-meta";
import type { FlowNode } from "@/lib/workflow-graph-model";
import { categoryColor, nodeStatusDot } from "@/lib/status-colors";
import { cn } from "@/lib/utils";
import { NodeCard } from "./NodeCard";

// React Flow custom node-type renderers. There are exactly TWO node components:
//   - <CardNode>      : every non-container node (all rendered through <NodeCard>)
//   - <ContainerNode> : parallel/loop/fanout group frames (children carry parentId)
// One renderer family, two modes — `data.runStatus` (set only in run mode) tints
// the card via the C2 color map. Terminals (start/end) get a single in/out handle.

function CardNode({ data, selected }: NodeProps<FlowNode>) {
  const node = data.node;
  const isStart = node.type === "start";
  const isEnd = node.type === "end";
  return (
    <>
      {!isStart ? (
        <Handle
          type="target"
          position={Position.Top}
          className="!size-2.5 !border-2 !border-background !bg-muted-foreground"
        />
      ) : null}
      <NodeCard
        node={node}
        selected={selected}
        runStatus={data.runStatus}
        iteration={data.iteration}
        dynamic={data.dynamic}
      />
      {!isEnd ? (
        <Handle
          type="source"
          position={Position.Bottom}
          className="!size-2.5 !border-2 !border-background !bg-muted-foreground"
        />
      ) : null}
    </>
  );
}

// Container = a labelled group frame. React Flow positions children inside it via
// parentId; we render a header card + a translucent body the children sit on top
// of. In run mode the frame border tints by status.
function ContainerNode({ data, selected }: NodeProps<FlowNode>) {
  const { t } = useTranslation();
  const node = data.node;
  const meta = NODE_TYPE_META[node.type];
  const Icon = meta?.icon;
  const tint = data.runStatus
    ? nodeStatusDot(data.runStatus)
    : categoryColor("in-progress").dot;
  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        className="!size-2.5 !border-2 !border-background !bg-muted-foreground"
      />
      <div
        className={cn(
          "flex h-full w-full flex-col rounded-xl border-2 border-dashed bg-muted/20 backdrop-blur-[1px]",
          selected ? "border-primary" : "border-border",
        )}
      >
        <div className="flex items-center gap-2 rounded-t-xl border-b border-border/60 bg-card/80 px-2.5 py-1.5">
          <span
            className={cn("size-2 shrink-0 rounded-full", tint)}
            aria-hidden
          />
          {Icon ? (
            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-xs font-semibold">
            {node.title || node.id}
          </span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            {t(`flow.nodeType.${meta?.labelKey ?? node.type}`, {
              defaultValue: node.type,
            })}
          </span>
        </div>
        <div className="flex-1" />
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!size-2.5 !border-2 !border-background !bg-muted-foreground"
      />
    </>
  );
}

export const nodeTypes = {
  card: CardNode,
  container: ContainerNode,
};
