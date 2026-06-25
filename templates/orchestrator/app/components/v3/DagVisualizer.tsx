import { useMemo } from "react";
import {
  IconRobot,
  IconGitFork,
  IconRefresh,
  IconShieldCheck,
  IconBox,
  IconChevronRight,
  IconClockHour3,
  IconCoin,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  useV3NodeSummary,
  type V3DagNode,
  type V3DagEdge,
  type V3Node,
} from "@/hooks/use-v3-run";
import {
  STATUS_DOT,
  STATUS_ACCENT,
  statusLabel,
  durationMs,
  fmtDuration,
  fmtTokens,
  agentPresentation,
  modelDisplay,
} from "./v3-format";

// ── Node type icon ───────────────────────────────────────────────────────────

function NodeTypeIcon({ type, className }: { type: string; className?: string }) {
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

// ── Layout: order the runtime nodes along their dependency chain ─────────────

interface FlowNode {
  dagNode: V3DagNode;
  runNode?: V3Node;
  agent: string | null;
  level: number;
}

function orderNodes(
  dagNodes: V3DagNode[],
  edges: V3DagEdge[],
  runNodes: V3Node[],
): FlowNode[] {
  const runMap = new Map(runNodes.map((n) => [n.nodeIdInDag, n]));

  // Dependency sets from deps[] + edges[].
  const depSet = new Map<string, Set<string>>();
  for (const d of dagNodes) depSet.set(d.id, new Set(d.deps ?? []));
  for (const e of edges) depSet.get(e.to)?.add(e.from);

  const levels = new Map<string, number>();
  const resolve = (id: string, seen: Set<string>): number => {
    const cached = levels.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0;
    seen.add(id);
    const deps = depSet.get(id);
    const lvl =
      !deps || deps.size === 0
        ? 0
        : Math.max(...[...deps].map((d) => resolve(d, seen))) + 1;
    levels.set(id, lvl);
    return lvl;
  };
  for (const n of dagNodes) resolve(n.id, new Set());

  return dagNodes
    .map((dagNode) => ({
      dagNode,
      runNode: runMap.get(dagNode.id),
      agent:
        typeof dagNode.agent === "string" ? (dagNode.agent as string) : null,
      level: levels.get(dagNode.id) ?? 0,
    }))
    .sort((a, b) => a.level - b.level);
}

// ── A single node card ───────────────────────────────────────────────────────

function NodeCard({
  flow,
  runId,
  selected,
  onSelect,
}: {
  flow: FlowNode;
  runId: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const { dagNode, runNode, agent } = flow;
  const status = runNode?.status ?? "pending";
  const accent = STATUS_ACCENT[status] ?? STATUS_ACCENT.pending;
  const dot = STATUS_DOT[status] ?? STATUS_DOT.pending;
  const agentInfo = agentPresentation(agent);

  // Pull the live per-node detail (model + tokens) once the node has a spawn.
  const { data: summary } = useV3NodeSummary(
    runId,
    runNode?.status && runNode.status !== "pending" ? runNode.id : null,
  );

  const dur = fmtDuration(
    durationMs(runNode?.startedAt, runNode?.completedAt),
  );
  const tokensTotal =
    summary?.spawn != null
      ? (summary.spawn.tokensInput ?? 0) + (summary.spawn.tokensOutput ?? 0)
      : null;
  const model = modelDisplay({
    modelRef: summary?.spawn?.modelRef,
    runtime: summary?.spawn?.runtime,
    engineRef: summary?.spawn?.engineRef,
  });

  return (
    <button
      type="button"
      onClick={onSelect}
      data-node-card={dagNode.id}
      className={cn(
        "group w-full rounded-xl border px-3.5 py-3 text-left transition-all",
        accent,
        selected
          ? "ring-2 ring-primary ring-offset-1 ring-offset-background"
          : "hover:border-foreground/30",
      )}
    >
      {/* Row 1: type icon + id + status */}
      <div className="flex items-center gap-2">
        <NodeTypeIcon
          type={dagNode.type}
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="truncate font-mono text-sm font-semibold text-foreground">
          {dagNode.id}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className={cn("size-2 rounded-full", dot)} />
          <span className="text-xs font-medium capitalize text-foreground/80">
            {statusLabel(status)}
          </span>
        </span>
      </div>

      {/* Row 2: agent + model */}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <Badge
          variant="outline"
          className={cn("h-5 px-1.5 text-[11px] font-medium", agentInfo.className)}
        >
          {agentInfo.label}
        </Badge>
        {model !== "—" ? (
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {model}
          </span>
        ) : null}
      </div>

      {/* Row 3: duration + tokens */}
      <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
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
        <IconChevronRight className="ml-auto size-3.5 opacity-0 transition-opacity group-hover:opacity-60" />
      </div>
    </button>
  );
}

// ── Connector between cards ──────────────────────────────────────────────────

function Connector() {
  return (
    <div className="flex h-5 items-center justify-center" aria-hidden>
      <div className="h-full w-0.5 rounded-full bg-border" />
    </div>
  );
}

// ── DagVisualizer (vertical flow of high-contrast node cards) ────────────────

export interface DagVisualizerProps {
  runId: string;
  dagNodes: V3DagNode[];
  edges: V3DagEdge[];
  runNodes: V3Node[];
  selectedNodeId?: string | null;
  onSelectNode: (nodeId: string) => void;
}

export function DagVisualizer({
  runId,
  dagNodes,
  edges,
  runNodes,
  selectedNodeId,
  onSelectNode,
}: DagVisualizerProps) {
  const ordered = useMemo(
    () => orderNodes(dagNodes, edges, runNodes),
    [dagNodes, edges, runNodes],
  );

  if (ordered.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No nodes in this run.
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto flex max-w-md flex-col">
        {ordered.map((flow, i) => (
          <div key={flow.dagNode.id}>
            {i > 0 ? <Connector /> : null}
            <NodeCard
              flow={flow}
              runId={runId}
              selected={selectedNodeId === flow.dagNode.id}
              onSelect={() => onSelectNode(flow.dagNode.id)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
