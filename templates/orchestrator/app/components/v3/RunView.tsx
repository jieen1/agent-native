import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import {
  IconArrowLeft,
  IconClockHour3,
  IconCoin,
  IconHierarchy3,
  IconBox,
  IconCircleCheck,
  IconCircleX,
  IconLoader2,
  IconGitBranch,
  IconExternalLink,
  IconStack2,
  IconHistory,
  IconActivity,
  IconMessageCircle,
  IconGitPullRequest,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  useV3RunState,
  useV3RunNodes,
  useV3RunDag,
  useV3RunPatches,
  useV3RunEvents,
  useV3RunSummary,
  type V3Node,
  type V3Patch,
  type V3DagNode,
} from "@/hooks/use-v3-run";
import { V3StatusBadge } from "./V3StatusBadge";
import { DagVisualizer } from "./DagVisualizer";
import { NodeInspector } from "./NodeInspector";
import { EventFeed } from "./EventFeed";
import {
  durationMs,
  fmtDuration,
  fmtTokens,
  fmtDateTime,
} from "./v3-format";

// ── Patch timeline ───────────────────────────────────────────────────────────

function PatchTimeline({ patches }: { patches: V3Patch[] }) {
  if (patches.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        No live DAG patches were applied to this run.
      </div>
    );
  }
  return (
    <div className="space-y-3 p-4">
      {patches.map((patch) => (
        <div
          key={patch.id}
          className="rounded-lg border border-border bg-card p-3"
        >
          <div className="flex items-center gap-2">
            <span className="size-2.5 shrink-0 rounded-full bg-purple-500" />
            <Badge variant="secondary" className="font-mono text-xs">
              v{patch.dagVersionBefore} → v{patch.dagVersionAfter}
            </Badge>
            <span className="text-xs text-muted-foreground">
              by {patch.actor}
            </span>
            {patch.appliedAt ? (
              <span className="ml-auto font-mono text-xs text-muted-foreground">
                {fmtDateTime(patch.appliedAt)}
              </span>
            ) : null}
          </div>
          {patch.reason ? (
            <p className="mt-1.5 pl-[18px] text-xs text-muted-foreground">
              {patch.reason}
            </p>
          ) : null}
          <details className="mt-1.5">
            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
              View operations
            </summary>
            <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono text-[10px]">
              {JSON.stringify(patch.patchOps, null, 2)}
            </pre>
          </details>
        </div>
      ))}
    </div>
  );
}

// ── Summary stat chip ────────────────────────────────────────────────────────

function StatChip({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof IconCoin;
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card/50 px-3 py-1.5">
      <Icon className={cn("size-4 shrink-0", tone ?? "text-muted-foreground")} />
      <div className="flex flex-col leading-tight">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <span className="font-mono text-sm font-semibold text-foreground">
          {value}
        </span>
      </div>
    </div>
  );
}

// ── Node-count pills ─────────────────────────────────────────────────────────

function NodeCountPills({
  counts,
}: {
  counts: Record<string, number>;
}) {
  const order: Array<[string, string, typeof IconCircleCheck]> = [
    ["done", "text-emerald-500", IconCircleCheck],
    ["running", "text-blue-500", IconLoader2],
    ["failed", "text-red-500", IconCircleX],
    ["awaiting-approval", "text-purple-500", IconBox],
    ["pending", "text-zinc-400", IconBox],
    ["skipped", "text-zinc-400", IconBox],
  ];
  const visible = order.filter(([k]) => (counts[k] ?? 0) > 0);
  if (visible.length === 0) return null;
  return (
    <div className="flex items-center gap-1.5">
      {visible.map(([k, tone, Icon]) => (
        <span
          key={k}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-card/50 px-2 py-1 text-xs"
          title={`${counts[k]} ${k}`}
        >
          <Icon
            className={cn(
              "size-3.5",
              tone,
              k === "running" && "animate-spin",
            )}
          />
          <span className="font-mono font-medium text-foreground">
            {counts[k]}
          </span>
          <span className="text-muted-foreground">{k.replace(/-/g, " ")}</span>
        </span>
      ))}
    </div>
  );
}

// ── RunView ──────────────────────────────────────────────────────────────────

export interface RunViewProps {
  runId: string;
}

export function RunView({ runId }: RunViewProps) {
  const { data: runState, isLoading: stateLoading, error } =
    useV3RunState(runId);
  const { data: nodes } = useV3RunNodes(runId);
  const { data: dag } = useV3RunDag(runId);
  const { data: patches } = useV3RunPatches(runId);
  const { data: historicalEvents } = useV3RunEvents(runId);
  const { data: rollup } = useV3RunSummary(runId);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"dag" | "events" | "patches">(
    "dag",
  );

  // Auto-select the first DAG node once it loads so the inspector is never an
  // empty panel on arrival — the run's output is visible immediately.
  useEffect(() => {
    if (!selectedNodeId && dag && dag.nodes.length > 0) {
      setSelectedNodeId(dag.nodes[0].id);
    }
  }, [dag, selectedNodeId]);

  // Resolve the selected DAG node to the most relevant runtime node.
  const selectedNode = useMemo((): V3Node | null | undefined => {
    if (!selectedNodeId || !nodes) return undefined;
    const candidates = nodes.filter((n) => n.nodeIdInDag === selectedNodeId);
    if (candidates.length === 0) return null;
    const rank: Record<string, number> = {
      running: 5,
      failed: 4,
      "awaiting-approval": 3,
      done: 2,
      ready: 1,
      pending: 0,
      skipped: 0,
    };
    return [...candidates].sort((a, b) => {
      const r = (rank[b.status] ?? 0) - (rank[a.status] ?? 0);
      if (r !== 0) return r;
      if (a.iteration !== b.iteration) return b.iteration - a.iteration;
      return b.fanoutIndex - a.fanoutIndex;
    })[0];
  }, [selectedNodeId, nodes]);

  const selectedDagNode = useMemo((): V3DagNode | undefined => {
    if (!selectedNodeId || !dag) return undefined;
    return dag.nodes.find((n) => n.id === selectedNodeId);
  }, [selectedNodeId, dag]);

  const dagAgent =
    selectedDagNode && typeof selectedDagNode.agent === "string"
      ? (selectedDagNode.agent as string)
      : null;

  // Workspace declared on the DAG nodes (shared across this run's agent nodes).
  const workspaceId = useMemo((): string | null => {
    if (!dag) return null;
    for (const n of dag.nodes) {
      if (typeof n.workspace === "string" && n.workspace) {
        return n.workspace as string;
      }
    }
    return null;
  }, [dag]);

  // Orchestrator linkage (DESIGN §16): a run dispatched from the tracker carries
  // the orchestrator session id (and, once committed, a PR/MR url) in its tags.
  const orchestrationSessionId = useMemo((): string | null => {
    const tags = runState?.tags;
    if (tags && typeof tags === "object") {
      const v = (tags as Record<string, unknown>).orchestrationSessionId;
      if (typeof v === "string" && v) return v;
    }
    return null;
  }, [runState?.tags]);

  const prUrl = useMemo((): string | null => {
    const tags = runState?.tags;
    if (tags && typeof tags === "object") {
      const v =
        (tags as Record<string, unknown>).pr_url ??
        (tags as Record<string, unknown>).prUrl;
      if (typeof v === "string" && v) return v;
    }
    return null;
  }, [runState?.tags]);

  function openOrchestratorChat() {
    if (!orchestrationSessionId) return;
    // The chat lives at "/" with thread management; signal it to open this run's
    // orchestrator session thread.
    window.dispatchEvent(
      new CustomEvent("agent-chat:open-thread", {
        detail: { threadId: orchestrationSessionId },
      }),
    );
  }

  const duration = useMemo(
    () =>
      fmtDuration(
        durationMs(
          runState?.startedAt,
          runState?.completedAt ?? new Date().toISOString(),
        ),
      ),
    [runState?.startedAt, runState?.completedAt],
  );

  const totalTokens = rollup?.tokens.total ?? null;

  if (stateLoading) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col">
        <header className="border-b border-border px-4 py-3">
          <Skeleton className="h-6 w-64" />
          <Skeleton className="mt-3 h-9 w-full max-w-xl" />
        </header>
        <div className="grid flex-1 gap-0 lg:grid-cols-[minmax(280px,360px)_1fr]">
          <Skeleton className="m-4 h-full rounded-lg" />
          <Skeleton className="m-4 h-full rounded-lg" />
        </div>
      </div>
    );
  }

  if (error || !runState) {
    return (
      <div className="m-4 rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
        Run not found or failed to load.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* ── Summary header ── */}
      <header className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild variant="ghost" size="sm" className="-ml-2">
            <Link to="/runs">
              <IconArrowLeft className="size-4" />
              Runs
            </Link>
          </Button>
          <h1 className="truncate font-mono text-sm font-semibold sm:text-base">
            {runId}
          </h1>
          <V3StatusBadge status={runState.status} />
          {workspaceId ? (
            <Button
              asChild
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs"
            >
              <Link to={`/workspaces/${workspaceId}`}>
                <IconGitBranch className="size-3.5" />
                Workspace
                <IconExternalLink className="size-3 opacity-60" />
              </Link>
            </Button>
          ) : null}
          {orchestrationSessionId ? (
            <Button
              asChild
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs"
              title={`Orchestrator session ${orchestrationSessionId}`}
            >
              <Link to="/" onClick={openOrchestratorChat}>
                <IconMessageCircle className="size-3.5" />
                Orchestrator
                <IconExternalLink className="size-3 opacity-60" />
              </Link>
            </Button>
          ) : null}
          {prUrl ? (
            <Button
              asChild
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs"
            >
              <a href={prUrl} target="_blank" rel="noreferrer">
                <IconGitPullRequest className="size-3.5" />
                PR
                <IconExternalLink className="size-3 opacity-60" />
              </a>
            </Button>
          ) : null}
        </div>

        {/* Stats row */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <StatChip
            icon={IconClockHour3}
            label="Duration"
            value={duration}
          />
          <StatChip
            icon={IconCoin}
            label="Total tokens"
            value={totalTokens != null ? fmtTokens(totalTokens) : "—"}
            tone="text-amber-500"
          />
          <StatChip
            icon={IconStack2}
            label="Nodes"
            value={String(runState.totalNodes)}
          />
          <div className="mx-1 hidden h-8 w-px bg-border sm:block" />
          <NodeCountPills counts={runState.nodeCounts} />
          <Badge
            variant="secondary"
            className="ml-auto hidden font-mono text-xs sm:inline-flex"
            title="DAG version"
          >
            <IconHierarchy3 className="mr-1 size-3" />
            DAG v{runState.dagVersion}
          </Badge>
        </div>
      </header>

      {/* ── Body: node flow (left) + tabbed detail (right) ── */}
      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(300px,380px)_1fr]">
        {/* Left: node flow */}
        <div className="flex min-h-0 flex-col border-b border-r-0 border-border lg:border-b-0 lg:border-r">
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
            <IconHierarchy3 className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">Workflow</span>
            <span className="ml-auto text-xs text-muted-foreground">
              {nodes?.length ?? 0} nodes
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {dag && nodes ? (
              <DagVisualizer
                runId={runId}
                dagNodes={dag.nodes}
                edges={dag.edges}
                runNodes={nodes}
                selectedNodeId={selectedNodeId}
                onSelectNode={setSelectedNodeId}
              />
            ) : (
              <div className="space-y-3 p-4">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-24 w-full rounded-xl" />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right: tabbed detail (Inspector / Events / Patches) */}
        <div className="flex min-h-0 flex-col">
          <Tabs
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as typeof activeTab)}
            className="flex h-full min-h-0 flex-col"
          >
            <div className="shrink-0 border-b border-border px-3 py-1.5">
              <TabsList className="h-8">
                <TabsTrigger value="dag" className="gap-1.5 text-xs">
                  <IconBox className="size-3.5" />
                  Node detail
                </TabsTrigger>
                <TabsTrigger value="events" className="gap-1.5 text-xs">
                  <IconActivity className="size-3.5" />
                  Events
                </TabsTrigger>
                <TabsTrigger value="patches" className="gap-1.5 text-xs">
                  <IconHistory className="size-3.5" />
                  Patches
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent
              value="dag"
              className="m-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
            >
              <NodeInspector
                runId={runId}
                node={selectedNode}
                dagNodeId={selectedNodeId}
                dagAgent={dagAgent}
                hasSelection={!!selectedNodeId}
              />
            </TabsContent>

            <TabsContent
              value="events"
              className="m-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
            >
              <EventFeed
                runId={runId}
                initialEvents={historicalEvents ?? []}
                live={
                  runState.status === "running" ||
                  runState.status === "pending" ||
                  runState.status === "paused"
                }
              />
            </TabsContent>

            <TabsContent
              value="patches"
              className="m-0 min-h-0 flex-1 overflow-auto data-[state=inactive]:hidden"
            >
              <PatchTimeline patches={patches ?? []} />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
