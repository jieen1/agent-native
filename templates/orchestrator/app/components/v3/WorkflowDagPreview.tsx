import { useMemo } from "react";
import { IconAlertCircle } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { NodeTypeDot } from "./WorkflowNodeTypeIcon";
import {
  nodeDepths,
  NODE_TYPE_LABEL,
  type WorkflowNode,
  type WorkflowNodeType,
} from "./workflow-dag-types";

const BOX_W = 172;
const BOX_H = 68;
const COL_GAP = 64;
const ROW_GAP = 20;
const PAD = 28;

interface LaidOutNode {
  node: WorkflowNode;
  x: number;
  y: number;
}

function layout(nodes: WorkflowNode[]): {
  boxes: LaidOutNode[];
  width: number;
  height: number;
} {
  const depths = nodeDepths(nodes);
  const columns = new Map<number, WorkflowNode[]>();
  for (const n of nodes) {
    const d = depths.get(n.id) ?? 0;
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d)!.push(n);
  }
  const colIndices = Array.from(columns.keys()).sort((a, b) => a - b);
  const boxes: LaidOutNode[] = [];
  let maxRows = 0;
  for (const col of colIndices) {
    const rows = columns.get(col)!;
    maxRows = Math.max(maxRows, rows.length);
    rows.forEach((node, rowIdx) => {
      boxes.push({
        node,
        x: PAD + col * (BOX_W + COL_GAP),
        y: PAD + rowIdx * (BOX_H + ROW_GAP),
      });
    });
  }
  const width =
    colIndices.length > 0
      ? PAD * 2 + colIndices.length * BOX_W + (colIndices.length - 1) * COL_GAP
      : PAD * 2;
  const height =
    PAD * 2 + Math.max(maxRows, 1) * BOX_H + Math.max(maxRows - 1, 0) * ROW_GAP;
  return { boxes, width, height };
}

const LEGEND_TYPES: WorkflowNodeType[] = [
  "agent",
  "parallel_over",
  "loop",
  "human_gate",
];

export interface WorkflowDagPreviewProps {
  nodes: WorkflowNode[];
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  errorsByNode: Record<string, string[]>;
}

/**
 * Read-only DAG graph preview for the template editor: boxes laid out in
 * columns by dependency depth, connected by simple curved SVG edges. This is
 * intentionally NOT a general graph-layout library — templates have modest
 * node counts and a column-by-depth layout is legible and cheap to compute.
 */
export function WorkflowDagPreview({
  nodes,
  selectedNodeId,
  onSelectNode,
  errorsByNode,
}: WorkflowDagPreviewProps) {
  const { boxes, width, height } = useMemo(() => layout(nodes), [nodes]);
  const posById = useMemo(() => {
    const m = new Map<string, LaidOutNode>();
    for (const b of boxes) m.set(b.node.id, b);
    return m;
  }, [boxes]);

  if (nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        暂无节点，从左侧添加一个节点开始。
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="flex-1 overflow-auto bg-muted/20"
        style={{
          backgroundImage:
            "radial-gradient(hsl(var(--border)) 1px, transparent 1px)",
          backgroundSize: "18px 18px",
        }}
      >
        <div
          className="relative m-6"
          style={{ width, height, minWidth: width, minHeight: height }}
        >
          <svg
            className="pointer-events-none absolute inset-0"
            width={width}
            height={height}
          >
            {boxes.flatMap(({ node, x, y }) =>
              (("deps" in node ? node.deps : undefined) ?? []).map((depId) => {
                const from = posById.get(depId);
                if (!from) return null;
                const x1 = from.x + BOX_W;
                const y1 = from.y + BOX_H / 2;
                const x2 = x;
                const y2 = y + BOX_H / 2;
                const mx = (x1 + x2) / 2;
                return (
                  <path
                    key={`${depId}->${node.id}`}
                    d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                    fill="none"
                    stroke="hsl(var(--muted-foreground) / 0.5)"
                    strokeWidth={1.5}
                  />
                );
              }),
            )}
          </svg>

          {boxes.map(({ node, x, y }) => {
            const hasError = (errorsByNode[node.id]?.length ?? 0) > 0;
            const selected = node.id === selectedNodeId;
            return (
              <button
                type="button"
                key={node.id}
                onClick={() => onSelectNode(node.id)}
                className={cn(
                  "absolute flex flex-col justify-center gap-1 rounded-md border bg-card p-2.5 text-left shadow-sm transition-shadow",
                  selected
                    ? "border-ring ring-2 ring-ring/30"
                    : hasError
                      ? "border-destructive ring-2 ring-destructive/20"
                      : "border-border hover:border-foreground/30",
                )}
                style={{ left: x, top: y, width: BOX_W, height: BOX_H }}
              >
                <div className="flex items-center gap-1.5">
                  <NodeTypeDot type={node.type} size="sm" />
                  <span className="truncate text-xs font-semibold">
                    {node.id}
                  </span>
                </div>
                {hasError ? (
                  <div className="flex items-center gap-1 text-[10px] text-destructive">
                    <IconAlertCircle className="size-3 shrink-0" />
                    <span className="truncate">{errorsByNode[node.id][0]}</span>
                  </div>
                ) : (
                  <span className="truncate text-[10.5px] text-muted-foreground">
                    {NODE_TYPE_LABEL[node.type]}
                    {"agent" in node && node.agent ? ` · ${node.agent}` : ""}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-4 border-t border-border px-4 py-2.5 text-[11.5px] text-muted-foreground">
        {LEGEND_TYPES.map((t) => (
          <div key={t} className="flex items-center gap-1.5">
            <NodeTypeDot type={t} size="sm" />
            {NODE_TYPE_LABEL[t]}
          </div>
        ))}
      </div>
    </div>
  );
}
