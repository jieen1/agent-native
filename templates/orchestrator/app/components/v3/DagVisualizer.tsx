import {
  IconRobot,
  IconGitFork,
  IconRefresh,
  IconShieldCheck,
  IconBox,
  IconClockHour3,
  IconCoin,
  IconZoomIn,
  IconZoomOut,
  IconMaximize,
  IconRotateClockwise2,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  useV3NodeSummary,
  type V3DagNode,
  type V3DagEdge,
  type V3Node,
} from "@/hooks/use-v3-run";
import { cn } from "@/lib/utils";

import { computeDagLayout, type DagLayoutNode } from "./dag-layout";
import { StatusMarker } from "./StatusMarker";
import {
  durationMs,
  fmtDuration,
  fmtTokens,
  agentPresentation,
  modelDisplay,
} from "./v3-format";

// ── Node type icon ───────────────────────────────────────────────────────────

function NodeTypeIcon({
  type,
  className,
}: {
  type: string;
  className?: string;
}) {
  switch (type) {
    case "agent":
      return <IconRobot className={className} />;
    case "parallel_over":
      return <IconGitFork className={className} />;
    case "loop":
      return <IconRefresh className={className} />;
    case "human_gate":
      return <IconShieldCheck className={className} />;
    default:
      return <IconBox className={className} />;
  }
}

// ── Canvas geometry ──────────────────────────────────────────────────────────

const CARD_W = 220;
const CARD_H = 96;
const COL_GAP = 96;
const ROW_GAP = 24;
const PAD = 32;

function nodeX(col: number): number {
  return PAD + col * (CARD_W + COL_GAP);
}
function nodeY(row: number): number {
  return PAD + row * (CARD_H + ROW_GAP);
}

// ── Runtime-node resolution per DAG node (handles fanout/loop iterations) ────

const STATUS_RANK: Record<string, number> = {
  running: 6,
  failed: 5,
  "awaiting-approval": 4,
  done: 3,
  ready: 2,
  pending: 1,
  skipped: 1,
};

/** Picks the most relevant runtime row when a DAG node has multiple (fanout/loop). */
function pickRepresentative(rows: V3Node[]): V3Node | undefined {
  if (rows.length === 0) return undefined;
  return [...rows].sort((a, b) => {
    const r = (STATUS_RANK[b.status] ?? 0) - (STATUS_RANK[a.status] ?? 0);
    if (r !== 0) return r;
    if (a.iteration !== b.iteration) return b.iteration - a.iteration;
    return b.fanoutIndex - a.fanoutIndex;
  })[0];
}

// ── A single node card ───────────────────────────────────────────────────────

function NodeCard({
  dagNode,
  runNode,
  fanoutCount,
  runId,
  selected,
  isParallel,
  x,
  y,
  onSelect,
}: {
  dagNode: V3DagNode;
  runNode: V3Node | undefined;
  fanoutCount: number;
  runId: string;
  selected: boolean;
  isParallel: boolean;
  x: number;
  y: number;
  onSelect: () => void;
}) {
  const status = runNode?.status ?? "pending";
  const agent =
    typeof dagNode.agent === "string" ? (dagNode.agent as string) : null;
  const agentInfo = agentPresentation(agent);

  const { data: summary } = useV3NodeSummary(
    runId,
    runNode?.status && runNode.status !== "pending" ? runNode.id : null,
  );

  const dur = fmtDuration(durationMs(runNode?.startedAt, runNode?.completedAt));
  const tokensTotal =
    summary?.spawn != null
      ? (summary.spawn.tokensInput ?? 0) + (summary.spawn.tokensOutput ?? 0)
      : null;
  const model = modelDisplay({
    modelRef: summary?.spawn?.modelRef,
    runtime: summary?.spawn?.runtime,
    engineRef: summary?.spawn?.engineRef,
  });

  // Real, non-fabricated node-level semantics for loop/retry (see the report:
  // the s7 prototype's loop/fail "back-edges" are illustrative flourish for
  // one example DAG — a V3 DAG is strictly acyclic — so loop iteration count
  // and retry policy are surfaced as node badges instead of invented edges.
  const maxIterations =
    (dagNode as Record<string, unknown>).max_iterations ??
    (dagNode as Record<string, unknown>).maxIterations;
  const retryMax = (dagNode as { retry?: { max?: number } }).retry?.max;

  return (
    <button
      type="button"
      onClick={onSelect}
      data-node-card={dagNode.id}
      className={cn(
        "absolute flex flex-col gap-1.5 rounded-xl border bg-card px-3.5 py-3 text-left shadow-sm transition-all",
        status === "failed"
          ? "border-red-500/60 bg-red-500/[0.06]"
          : status === "running"
            ? "border-blue-500/60 bg-blue-500/5"
            : status === "done"
              ? "border-emerald-500/50 bg-emerald-500/[0.04]"
              : status === "awaiting-approval"
                ? "border-purple-500/60 bg-purple-500/[0.06]"
                : "border-border",
        status === "pending" && "border-dashed",
        selected
          ? "ring-2 ring-primary ring-offset-1 ring-offset-background"
          : "hover:border-foreground/40",
      )}
      style={{ left: x, top: y, width: CARD_W, height: CARD_H }}
    >
      {/* Row 1: type icon + id + status marker */}
      <div className="flex items-center gap-1.5">
        <NodeTypeIcon
          type={dagNode.type}
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="truncate font-mono text-[13px] font-semibold text-foreground">
          {dagNode.id}
        </span>
        {isParallel ? (
          <span
            title="与其它节点并行（依赖图同层，非串行顺序）"
            className="rounded-sm bg-sky-500/10 px-1 text-[9px] font-semibold uppercase tracking-wide text-sky-600 dark:text-sky-400"
          >
            并行
          </span>
        ) : null}
        {fanoutCount > 1 ? (
          <Badge variant="secondary" className="h-4 px-1 font-mono text-[10px]">
            ×{fanoutCount}
          </Badge>
        ) : null}
        <span className="ml-auto shrink-0">
          <StatusMarker status={status} size="sm" ringSize={14} />
        </span>
      </div>

      {/* Row 2: agent + model + loop/retry badges */}
      <div className="flex flex-wrap items-center gap-1">
        {agent ? (
          <Badge
            variant="outline"
            className={cn(
              "h-4.5 px-1.5 text-[10px] font-medium",
              agentInfo.className,
            )}
          >
            {agentInfo.label}
          </Badge>
        ) : null}
        {model !== "—" ? (
          <span className="truncate font-mono text-[10.5px] text-muted-foreground">
            {model}
          </span>
        ) : null}
        {typeof maxIterations === "number" ? (
          <span className="inline-flex items-center gap-0.5 text-[10px] text-info">
            <IconRefresh className="size-2.5" />
            循环 ≤{maxIterations}
          </span>
        ) : null}
        {typeof retryMax === "number" ? (
          <span className="text-[10px] text-muted-foreground">
            重试上限 {retryMax}
          </span>
        ) : null}
      </div>

      {/* Row 3: duration + tokens */}
      <div className="mt-auto flex items-center gap-2.5 text-[10.5px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <IconClockHour3 className="size-3" />
          {dur}
        </span>
        {tokensTotal != null ? (
          <span className="inline-flex items-center gap-1">
            <IconCoin className="size-3" />
            {fmtTokens(tokensTotal)} tok
          </span>
        ) : null}
      </div>
    </button>
  );
}

// ── DagVisualizer ────────────────────────────────────────────────────────────

export interface DagVisualizerProps {
  runId: string;
  dagNodes: V3DagNode[];
  edges: V3DagEdge[];
  runNodes: V3Node[];
  selectedNodeId?: string | null;
  onSelectNode: (nodeId: string) => void;
}

/**
 * Renders the run's DAG as a real graph: nodes laid out in columns by
 * dependency depth (computeDagLayout — see dag-layout.ts) and connected by
 * SVG bezier edges, so nodes that share a column (real parallel siblings —
 * e.g. gateStack/gateTests/gateNone) are visually distinct from a serial
 * chain, instead of one continuous vertical list of cards.
 */
export function DagVisualizer({
  runId,
  dagNodes,
  edges,
  runNodes,
  selectedNodeId,
  onSelectNode,
}: DagVisualizerProps) {
  const [zoom, setZoom] = useState(1);

  const layoutNodes: DagLayoutNode[] = useMemo(
    () => dagNodes.map((n) => ({ id: n.id, type: n.type, deps: n.deps })),
    [dagNodes],
  );
  const layout = useMemo(
    () => computeDagLayout(layoutNodes, edges),
    [layoutNodes, edges],
  );

  const runNodesByDag = useMemo(() => {
    const m = new Map<string, V3Node[]>();
    for (const n of runNodes) {
      if (!m.has(n.nodeIdInDag)) m.set(n.nodeIdInDag, []);
      m.get(n.nodeIdInDag)!.push(n);
    }
    return m;
  }, [runNodes]);

  const dagNodeById = useMemo(() => {
    const m = new Map<string, V3DagNode>();
    for (const n of dagNodes) m.set(n.id, n);
    return m;
  }, [dagNodes]);

  const width =
    PAD * 2 +
    layout.columnCount * CARD_W +
    Math.max(layout.columnCount - 1, 0) * COL_GAP;
  const height =
    PAD * 2 +
    Math.max(layout.maxRows, 1) * CARD_H +
    Math.max(layout.maxRows - 1, 0) * ROW_GAP;

  if (dagNodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        本次运行没有节点。
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div
        className="min-h-0 flex-1 overflow-auto"
        style={{
          backgroundImage:
            "radial-gradient(hsl(var(--border)) 1px, transparent 1px)",
          backgroundSize: "22px 22px",
        }}
      >
        <div
          className="relative m-6 origin-top-left"
          style={{
            width,
            height,
            minWidth: width,
            minHeight: height,
            transform: zoom !== 1 ? `scale(${zoom})` : undefined,
          }}
        >
          <svg
            className="pointer-events-none absolute inset-0 overflow-visible"
            width={width}
            height={height}
          >
            <defs>
              <marker
                id="dag-arrow-done"
                markerWidth="7"
                markerHeight="7"
                refX="6"
                refY="3.5"
                orient="auto"
              >
                <path d="M0,0 L7,3.5 L0,7 Z" className="fill-emerald-500" />
              </marker>
              <marker
                id="dag-arrow-failed"
                markerWidth="7"
                markerHeight="7"
                refX="6"
                refY="3.5"
                orient="auto"
              >
                <path d="M0,0 L7,3.5 L0,7 Z" className="fill-red-500" />
              </marker>
              <marker
                id="dag-arrow-pending"
                markerWidth="7"
                markerHeight="7"
                refX="6"
                refY="3.5"
                orient="auto"
              >
                <path
                  d="M0,0 L7,3.5 L0,7 Z"
                  className="fill-muted-foreground"
                />
              </marker>
            </defs>
            {layout.edges.map((e) => {
              const fromCol = layout.depthOf.get(e.from);
              const fromRow = layout.rowOf.get(e.from);
              const toCol = layout.depthOf.get(e.to);
              const toRow = layout.rowOf.get(e.to);
              if (
                fromCol === undefined ||
                fromRow === undefined ||
                toCol === undefined ||
                toRow === undefined
              )
                return null;
              const x1 = nodeX(fromCol) + CARD_W;
              const y1 = nodeY(fromRow) + CARD_H / 2;
              const x2 = nodeX(toCol);
              const y2 = nodeY(toRow) + CARD_H / 2;
              const mx = (x1 + x2) / 2;

              const fromRep = pickRepresentative(
                runNodesByDag.get(e.from) ?? [],
              );
              const fromStatus = fromRep?.status ?? "pending";
              const strokeClass =
                fromStatus === "done"
                  ? "stroke-emerald-500"
                  : fromStatus === "failed"
                    ? "stroke-red-500"
                    : "stroke-muted-foreground/50";
              const marker =
                fromStatus === "done"
                  ? "url(#dag-arrow-done)"
                  : fromStatus === "failed"
                    ? "url(#dag-arrow-failed)"
                    : "url(#dag-arrow-pending)";

              return (
                <path
                  key={`${e.from}->${e.to}`}
                  d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                  fill="none"
                  strokeWidth={1.6}
                  className={strokeClass}
                  markerEnd={marker}
                />
              );
            })}
          </svg>

          {dagNodes.map((dagNode) => {
            const col = layout.depthOf.get(dagNode.id) ?? 0;
            const row = layout.rowOf.get(dagNode.id) ?? 0;
            const rows = runNodesByDag.get(dagNode.id) ?? [];
            return (
              <NodeCard
                key={dagNode.id}
                dagNode={dagNodeById.get(dagNode.id) ?? dagNode}
                runNode={pickRepresentative(rows)}
                fanoutCount={rows.length}
                runId={runId}
                selected={selectedNodeId === dagNode.id}
                isParallel={layout.parallelNodeIds.has(dagNode.id)}
                x={nodeX(col)}
                y={nodeY(row)}
                onSelect={() => onSelectNode(dagNode.id)}
              />
            );
          })}
        </div>
      </div>

      {/* Zoom controls — minimap is a follow-up (see report), not implemented here. */}
      <div className="absolute bottom-14 right-3 flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 rounded-none"
          title="放大"
          onClick={() => setZoom((z) => Math.min(1.4, +(z + 0.1).toFixed(2)))}
        >
          <IconZoomIn className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 rounded-none border-t border-border"
          title="缩小"
          onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.1).toFixed(2)))}
        >
          <IconZoomOut className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 rounded-none border-t border-border"
          title="重置缩放"
          onClick={() => setZoom(1)}
        >
          <IconMaximize className="size-3.5" />
        </Button>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border bg-background/85 px-3 py-1.5 text-[10.5px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-0.5 w-4 bg-emerald-500" />
          依赖已完成
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-0.5 w-4 bg-muted-foreground/50" />
          依赖待完成
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-0.5 w-4 bg-red-500" />
          依赖失败
        </span>
        <span className="ml-auto">
          边 = 依赖（非执行顺序）· 同列 = 并行 · 循环/重试为节点属性徽标，非图边
        </span>
        {zoom !== 1 ? (
          <span className="inline-flex items-center gap-1">
            <IconRotateClockwise2 className="size-3" />
            {Math.round(zoom * 100)}%
          </span>
        ) : null}
      </div>
    </div>
  );
}
