import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { useActionMutation } from "@agent-native/core/client";
import { IconArrowLeft } from "@tabler/icons-react";
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
  type V3Node,
  type V3Patch,
} from "@/hooks/use-v3-run";
import { V3StatusBadge } from "./V3StatusBadge";
import { DagVisualizer } from "./DagVisualizer";
import { NodeInspector } from "./NodeInspector";
import { EventFeed } from "./EventFeed";

// ── Patch history timeline ──────────────────────────────────────────────────

function PatchTimeline({ patches }: { patches: V3Patch[] }) {
  if (patches.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No patches applied to this run
      </div>
    );
  }

  return (
    <div className="space-y-3 p-4">
      {patches.map((patch) => (
        <div
          key={patch.id}
          className="flex items-start gap-3 rounded-lg border border-border bg-card p-3"
        >
          {/* Timeline dot */}
          <div className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-purple-500" />

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="font-mono text-xs">
                v{patch.dagVersionBefore} → v{patch.dagVersionAfter}
              </Badge>
              <span className="text-xs text-muted-foreground">
                by {patch.actor}
              </span>
              {patch.appliedAt ? (
                <span className="ml-auto font-mono text-xs text-muted-foreground">
                  {new Date(patch.appliedAt).toLocaleString()}
                </span>
              ) : null}
            </div>
            {patch.reason ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {patch.reason}
              </p>
            ) : null}
            <details className="mt-1">
              <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                View operations
              </summary>
              <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono text-[10px]">
                {JSON.stringify(patch.patchOps, null, 2)}
              </pre>
            </details>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Run status summary chips ─────────────────────────────────────────────────

function NodeCountChips({
  nodeCounts,
  totalNodes,
}: {
  nodeCounts: Record<string, number>;
  totalNodes: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">
        {totalNodes} nodes
      </span>
      {Object.entries(nodeCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([status, count]) => (
          <span
            key={status}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-xs"
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                status === "done" && "bg-emerald-500",
                status === "running" && "bg-blue-500",
                status === "failed" && "bg-red-500",
                status === "skipped" && "bg-gray-400",
                status === "pending" && "bg-slate-400",
                status === "awaiting-approval" && "bg-purple-500",
                status === "ready" && "bg-sky-400",
              )}
            />
            {status}: {count}
          </span>
        ))}
    </div>
  );
}

// ── RunView Component ────────────────────────────────────────────────────────

export interface RunViewProps {
  runId: string;
}

export function RunView({ runId }: RunViewProps) {
  const { data: runState, isLoading: stateLoading, error } = useV3RunState(runId);
  const { data: nodes } = useV3RunNodes(runId);
  const { data: dag } = useV3RunDag(runId);
  const { data: patches } = useV3RunPatches(runId);
  const { data: historicalEvents } = useV3RunEvents(runId);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"dag" | "patches" | "events">("dag");

  const navigate = useActionMutation("navigate", {});

  // Write application_state so the agent knows the user is on this v3 run view
  useEffect(() => {
    if (runId) {
      navigate.mutate({ path: `/v3/runs/${runId}` });
    }
  }, [runId, navigate]);

  // Resolve selected DAG node to the most relevant runtime node
  const selectedNode = useMemo((): V3Node | null | undefined => {
    if (!selectedNodeId || !nodes) return undefined;
    const candidates = nodes.filter(
      (n) => n.nodeIdInDag === selectedNodeId,
    );
    if (candidates.length === 0) return undefined;
    // Prefer running > failed > awaiting-approval > done > others
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

  const isRunning = runState?.status === "running";
  const isPaused = runState?.status === "paused";
  const isTerminal =
    runState?.status === "done" ||
    runState?.status === "failed" ||
    runState?.status === "cancelled";

  // Duration helper
  const duration = useMemo((): string | null => {
    if (!runState) return null;
    const start = runState.startedAt;
    const end = runState.completedAt ?? new Date().toISOString();
    if (!start) return null;
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (ms < 0) return null;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }, [runState]);

  if (stateLoading) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <Skeleton className="h-5 w-64" />
          <Skeleton className="h-8 w-32" />
        </header>
        <div className="grid flex-1 gap-4 p-4 lg:grid-cols-[1fr_360px]">
          <Skeleton className="h-full w-full rounded-lg" />
          <Skeleton className="h-full w-full rounded-lg" />
        </div>
      </div>
    );
  }

  if (error || !runState) {
    return (
      <div className="m-4 rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
        Run not found or failed to load
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* ── Header ── */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <Link to="/v3/runs">
              <IconArrowLeft className="size-4" />
              Back
            </Link>
          </Button>
          <h1 className="truncate font-mono text-sm font-semibold sm:text-base">
            {runId}
          </h1>
          <V3StatusBadge status={runState.status} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Duration */}
          {duration ? (
            <span className="rounded-md border border-border bg-card px-2.5 py-1 font-mono text-xs">
              {duration}
            </span>
          ) : null}

          {/* DAG version */}
          <Badge variant="secondary" className="font-mono text-xs">
            DAG v{runState.dagVersion}
          </Badge>

          {/* Node counts */}
          <NodeCountChips
            nodeCounts={runState.nodeCounts}
            totalNodes={runState.totalNodes}
          />

          {/* Status indicators — pause/resume actions wired via agent */}
          {isRunning ? (
            <Badge
              variant="outline"
              className="animate-pulse text-xs"
              title="Run is running — use the agent to pause"
            >
              Running
            </Badge>
          ) : null}
          {isPaused ? (
            <Badge
              variant="outline"
              className="text-xs"
              title="Run is paused — use the agent to resume"
            >
              Paused
            </Badge>
          ) : null}
          {isTerminal ? (
            <Badge variant="outline" className="text-xs">
              Terminal
            </Badge>
          ) : null}
        </div>
      </header>

      {/* ── Body ── */}
      <div className="grid min-h-0 flex-1 grid-rows-[1fr_auto] gap-0">
        {/* Top: DAG (left) + Inspector (right) */}
        <div className="grid min-h-0 gap-0 lg:grid-cols-[1fr_minmax(300px,380px)]">
          {/* DAG Visualizer with tabs */}
          <div className="flex min-h-[260px] min-w-0 flex-col border-r border-border">
            <Tabs
              value={activeTab}
              onValueChange={(v) => setActiveTab(v as typeof activeTab)}
              className="h-full"
            >
              <div className="flex items-center justify-between border-b border-border px-3">
                <TabsList className="h-8">
                  <TabsTrigger value="dag" className="text-xs">
                    DAG
                  </TabsTrigger>
                  <TabsTrigger value="patches" className="text-xs">
                    Patches
                  </TabsTrigger>
                  <TabsTrigger value="events" className="text-xs">
                    Events
                  </TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="dag" className="m-0 flex-1">
                <div className="h-full">
                  {dag && nodes ? (
                    <DagVisualizer
                      dagNodes={dag.nodes}
                      edges={dag.edges}
                      runNodes={nodes}
                      selectedNodeId={selectedNodeId}
                      onSelectNode={setSelectedNodeId}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                      Loading DAG...
                    </div>
                  )}
                </div>
              </TabsContent>

              <TabsContent value="patches" className="m-0 flex-1 overflow-hidden">
                <div className="h-full overflow-auto">
                  <PatchTimeline patches={patches ?? []} />
                </div>
              </TabsContent>

              <TabsContent value="events" className="m-0 flex-1 overflow-hidden">
                <div className="h-full">
                  <EventFeed
                    runId={runId}
                    initialEvents={historicalEvents ?? []}
                  />
                </div>
              </TabsContent>
            </Tabs>
          </div>

          {/* Node Inspector */}
          <aside className="min-h-0 min-w-0 overflow-hidden p-3">
            <NodeInspector
              node={selectedNode ?? null}
              loading={!nodes && !!selectedNodeId}
              hasSelection={!!selectedNodeId}
            />
          </aside>
        </div>
      </div>
    </div>
  );
}
