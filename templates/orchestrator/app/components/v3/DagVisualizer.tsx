import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { V3DagNode, V3DagEdge, V3Node } from "@/hooks/use-v3-run";

// ── Node shape icons ─────────────────────────────────────────────────────────

function NodeShapeIcon({ type }: { type: string }) {
  switch (type) {
    case "agent":
      return (
        <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <circle cx="12" cy="8" r="4" />
          <path d="M6 20v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" />
        </svg>
      );
    case "parallel_over":
      return (
        <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      );
    case "loop":
      return (
        <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path d="M4 12a8 8 0 0 1 14.93-4M20 12a8 8 0 0 1-14.93 4" />
          <path d="M18 3v4h-4" />
          <path d="M6 21v-4h4" />
        </svg>
      );
    case "human_gate":
      return (
        <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <rect x="3" y="3" width="18" height="18" rx="2" />
        </svg>
      );
  }
}

// ── Status colour tokens ─────────────────────────────────────────────────────

const STATUS_BORDER: Record<string, string> = {
  pending: "border-slate-300 dark:border-slate-600",
  ready: "border-sky-300 dark:border-sky-600",
  running: "border-blue-400 dark:border-blue-500",
  done: "border-emerald-400 dark:border-emerald-500",
  failed: "border-red-400 dark:border-red-500",
  skipped: "border-gray-300 dark:border-gray-600",
  "awaiting-approval": "border-purple-400 dark:border-purple-500",
};

const STATUS_BG: Record<string, string> = {
  pending: "bg-slate-50 dark:bg-slate-900/50",
  ready: "bg-sky-50 dark:bg-sky-950/30",
  running: "bg-blue-50 dark:bg-blue-950/30",
  done: "bg-emerald-50 dark:bg-emerald-950/30",
  failed: "bg-red-50 dark:bg-red-950/30",
  skipped: "bg-gray-50 dark:bg-gray-900/50",
  "awaiting-approval": "bg-purple-50 dark:bg-purple-950/30",
};

const STATUS_DOT: Record<string, string> = {
  running: "bg-blue-500",
  done: "bg-emerald-500",
  failed: "bg-red-500",
  skipped: "bg-gray-400",
  "awaiting-approval": "bg-purple-500",
  ready: "bg-sky-400",
  pending: "bg-slate-400",
};

// ── Auto-layout engine ──────────────────────────────────────────────────────

interface PositionedNode {
  dagNode: V3DagNode;
  runNode?: V3Node;
  x: number;
  y: number;
  level: number;
  col: number;
  runtimeStatus?: string;
  runtimeType?: string;
  iteration?: number;
  fanoutIndex?: number;
}

const NODE_W = 160;
const NODE_H = 64;
const GAP_X = 80;
const GAP_Y = 40;

function layoutNodes(
  dagNodes: V3DagNode[],
  edges: V3DagEdge[],
  runNodes: V3Node[],
): PositionedNode[] {
  const dagMap = new Map(dagNodes.map((n) => [n.id, n]));
  const runMap = new Map(runNodes.map((n) => [n.nodeIdInDag, n]));

  // Build dependency sets from both deps[] and edges[]
  const depSet = new Map<string, Set<string>>();
  for (const dag of dagNodes) {
    depSet.set(dag.id, new Set(dag.deps ?? []));
  }
  for (const e of edges) {
    const s = depSet.get(e.to);
    if (s) s.add(e.from);
  }

  // Topological levels (longest-path)
  const levels = new Map<string, number>();

  function resolveLevel(id: string, visited: Set<string>): number {
    const cached = levels.get(id);
    if (cached !== undefined) return cached;
    if (visited.has(id)) return 0;
    visited.add(id);
    const deps = depSet.get(id);
    if (!deps || deps.size === 0) {
      levels.set(id, 0);
      return 0;
    }
    const maxDep = Math.max(...[...deps].map((d) => resolveLevel(d, visited)));
    const lvl = maxDep + 1;
    levels.set(id, lvl);
    return lvl;
  }

  for (const n of dagNodes) {
    resolveLevel(n.id, new Set());
  }

  // Group by level
  const levelGroups = new Map<number, string[]>();
  for (const n of dagNodes) {
    const lvl = levels.get(n.id) ?? 0;
    if (!levelGroups.has(lvl)) levelGroups.set(lvl, []);
    levelGroups.get(lvl)!.push(n.id);
  }

  const sorted = Array.from(levelGroups.entries()).sort((a, b) => a[0] - b[0]);
  const result: PositionedNode[] = [];

  for (const [lvl, ids] of sorted) {
    for (let i = 0; i < ids.length; i++) {
      const dagNode = dagMap.get(ids[i]);
      if (!dagNode) continue;
      const runNode = runMap.get(ids[i]);
      result.push({
        dagNode,
        runNode,
        x: i * (NODE_W + GAP_X),
        y: lvl * (NODE_H + GAP_Y),
        level: lvl,
        col: i,
        runtimeStatus: runNode?.status,
        runtimeType: runNode?.type ?? dagNode.type,
        iteration: runNode?.iteration,
        fanoutIndex: runNode?.fanoutIndex,
      });
    }
  }

  return result;
}

// ── DagVisualizer Component ─────────────────────────────────────────────────

export interface DagVisualizerProps {
  dagNodes: V3DagNode[];
  edges: V3DagEdge[];
  runNodes: V3Node[];
  selectedNodeId?: string | null;
  onSelectNode: (nodeId: string) => void;
}

export function DagVisualizer({
  dagNodes,
  edges,
  runNodes,
  selectedNodeId,
  onSelectNode,
}: DagVisualizerProps) {
  const positioned = useMemo(
    () => layoutNodes(dagNodes, edges, runNodes),
    [dagNodes, edges, runNodes],
  );

  const posMap = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    for (const p of positioned) {
      m.set(p.dagNode.id, {
        x: p.x + NODE_W / 2,
        y: p.y + NODE_H / 2,
      });
    }
    return m;
  }, [positioned]);

  const svgEdges = useMemo(
    () =>
      edges.map((e) => {
        const from = posMap.get(e.from);
        const to = posMap.get(e.to);
        if (!from || !to) return null;
        const dx = to.x - from.x;
        const cp = Math.abs(dx) * 0.5;
        return {
          d: `M${from.x},${from.y} C${from.x + cp},${from.y} ${to.x - cp},${to.y} ${to.x},${to.y}`,
          key: `${e.from}-${e.to}`,
        };
      }),
    [edges, posMap],
  );

  const totalW =
    Math.max(...positioned.map((p) => p.x + NODE_W), 0) + 40;
  const totalH =
    Math.max(...positioned.map((p) => p.y + NODE_H), 0) + 40;

  if (positioned.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No nodes in DAG
      </div>
    );
  }

  return (
    <div className="overflow-auto p-4">
      <svg
        width={totalW}
        height={totalH}
        className="overflow-visible"
      >
        <defs>
          <marker
            id="arrowhead"
            markerWidth="6"
            markerHeight="6"
            refX="5"
            refY="3"
            orient="auto"
          >
            <polygon
              points="0 0, 6 3, 0 6"
              fill="hsl(var(--muted-foreground))"
              fillOpacity={0.4}
            />
          </marker>
        </defs>

        {/* Edges */}
        <g className="pointer-events-none">
          {svgEdges
            .filter((e): e is NonNullable<typeof e> => e !== null)
            .map((edge) => (
              <path
                key={edge.key}
                d={edge.d}
                fill="none"
                stroke="hsl(var(--muted-foreground))"
                strokeWidth={1.5}
                strokeOpacity={0.3}
                markerEnd="url(#arrowhead)"
              />
            ))}
        </g>

        {/* Nodes */}
        {positioned.map((pos) => {
          const isSelected = selectedNodeId === pos.dagNode.id;
          const status = pos.runtimeStatus ?? "pending";
          const border = STATUS_BORDER[status] ?? STATUS_BORDER.pending;
          const bg = STATUS_BG[status] ?? STATUS_BG.pending;
          const dot = STATUS_DOT[status] ?? STATUS_DOT.pending;

          return (
            <g
              key={pos.dagNode.id}
              transform={`translate(${pos.x}, ${pos.y})`}
              onClick={() => onSelectNode(pos.dagNode.id)}
              className="cursor-pointer"
            >
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={8}
                className={cn(
                  "stroke-2 transition-colors",
                  bg,
                  border,
                  isSelected && "ring-2 ring-foreground",
                )}
              />
              {/* Type icon */}
              <g transform="translate(10, 14)" className="text-muted-foreground">
                <foreignObject width="24" height="24">
                  <NodeShapeIcon type={pos.dagNode.type} />
                </foreignObject>
              </g>
              {/* Node id label */}
              <text
                x={40}
                y={28}
                className="fill-foreground text-xs font-medium"
              >
                {pos.dagNode.id}
              </text>
              {/* Status indicator */}
              <g transform="translate(40, 36)">
                <circle
                  cx={3}
                  cy={3}
                  r={3}
                  className={cn("fill-current", dot)}
                />
                <text
                  x={12}
                  y={7}
                  className="fill-muted-foreground text-[10px]"
                >
                  {status}
                </text>
              </g>
              {/* Iteration / fanout label */}
              {(pos.iteration ?? 0) > 0 || (pos.fanoutIndex ?? 0) > 0 ? (
                <text
                  x={NODE_W - 10}
                  y={16}
                  textAnchor="end"
                  className="fill-muted-foreground text-[10px] font-mono"
                >
                  {(pos.iteration ?? 0) > 0
                    ? `it#${pos.iteration}`
                    : (pos.fanoutIndex ?? 0) > 0
                      ? `[${pos.fanoutIndex}]`
                      : ""}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
