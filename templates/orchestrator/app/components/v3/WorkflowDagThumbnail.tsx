import { useMemo } from "react";

import { cn } from "@/lib/utils";

import { nodeDeps, nodeDepths, type WorkflowNode } from "./workflow-dag-types";
import { DOT_COLORS } from "./WorkflowNodeTypeIcon";

/**
 * Tiny, read-only DAG thumbnail for the workflow library's card grid (04 §4
 * "DAG 缩略图"). Deliberately NOT the full `WorkflowDagPreview` (that
 * component is an interactive, scrollable, legend-bearing editor canvas) —
 * this reuses the SAME column-by-dependency-depth layout idea and the SAME
 * per-node-type color mapping (`DOT_COLORS`), just laid out in percentage
 * units so it scales down to a ~36px card strip with no measured pixel
 * layout / ResizeObserver needed.
 */
export function WorkflowDagThumbnail({
  nodes,
  className,
}: {
  nodes: WorkflowNode[];
  className?: string;
}) {
  const layout = useMemo(() => computeThumbnailLayout(nodes), [nodes]);

  if (nodes.length === 0) {
    return (
      <div
        className={cn(
          "flex h-9 items-center justify-center text-[10.5px] text-muted-foreground",
          className,
        )}
      >
        暂无节点
      </div>
    );
  }

  return (
    <div className={cn("relative h-9 w-full", className)}>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full"
      >
        {layout.edges.map((e) => (
          <path
            key={e.key}
            d={e.d}
            fill="none"
            stroke="hsl(var(--muted-foreground) / 0.45)"
            strokeWidth={1.4}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      {layout.boxes.map((b) => (
        <div
          key={b.node.id}
          title={`${b.node.id} (${b.node.type})`}
          className={cn("absolute rounded-[3px]", DOT_COLORS[b.node.type])}
          style={{
            left: `${b.x}%`,
            top: `${b.y}%`,
            width: `${b.w}%`,
            height: `${b.h}%`,
            opacity: 0.85,
          }}
        />
      ))}
    </div>
  );
}

interface ThumbnailBox {
  node: WorkflowNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ThumbnailEdge {
  key: string;
  d: string;
}

const PAD = 4;
const COL_GAP = 6;
const ROW_GAP = 6;

function computeThumbnailLayout(nodes: WorkflowNode[]): {
  boxes: ThumbnailBox[];
  edges: ThumbnailEdge[];
} {
  const depths = nodeDepths(nodes);
  const columns = new Map<number, WorkflowNode[]>();
  for (const n of nodes) {
    const d = depths.get(n.id) ?? 0;
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d)!.push(n);
  }
  const colIndices = [...columns.keys()].sort((a, b) => a - b);
  const numCols = colIndices.length || 1;
  const colWidth = (100 - PAD * 2 - COL_GAP * (numCols - 1)) / numCols;

  const boxes: ThumbnailBox[] = [];
  const centerByNodeId = new Map<
    string,
    { rightX: number; leftX: number; y: number }
  >();

  colIndices.forEach((colIdx, i) => {
    const rows = columns.get(colIdx)!;
    const rowHeight =
      (100 - PAD * 2 - ROW_GAP * (rows.length - 1)) / rows.length;
    const x = PAD + i * (colWidth + COL_GAP);
    rows.forEach((node, rowIdx) => {
      const y = PAD + rowIdx * (rowHeight + ROW_GAP);
      boxes.push({ node, x, y, w: colWidth, h: rowHeight });
      centerByNodeId.set(node.id, {
        leftX: x,
        rightX: x + colWidth,
        y: y + rowHeight / 2,
      });
    });
  });

  const edges: ThumbnailEdge[] = [];
  for (const node of nodes) {
    const to = centerByNodeId.get(node.id);
    if (!to) continue;
    for (const depId of nodeDeps(node)) {
      const from = centerByNodeId.get(depId);
      if (!from) continue;
      const midX = (from.rightX + to.leftX) / 2;
      edges.push({
        key: `${depId}->${node.id}`,
        d: `M${from.rightX},${from.y} C${midX},${from.y} ${midX},${to.y} ${to.leftX},${to.y}`,
      });
    }
  }

  return { boxes, edges };
}
