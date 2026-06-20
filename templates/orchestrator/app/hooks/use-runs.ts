import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import { useQueryClient } from "@tanstack/react-query";

// v2 run-console hooks (DESIGN §4.4 / FRONTEND §4, §13 phase1). Added ALONGSIDE
// the v1 use-orchestrator hooks; these drive the read-only run console off the
// v2 engine actions (run-graph / node-get / list-runs) and the run controls
// (run-start / run-pause / run-resume / run-cancel). All data flows through
// useActionQuery / useActionMutation — never raw fetch.

export type RunStatus =
  | "pending"
  | "running"
  | "paused"
  | "done"
  | "failed"
  | "cancelled";

export type NodeRunStatus =
  | "pending"
  | "ready"
  | "running"
  | "done"
  | "failed"
  | "skipped"
  | "awaiting-approval";

export interface RunListItem {
  id: string;
  templateId: string;
  workItemId: string | null;
  status: RunStatus;
  tokenBudget: number | null;
  tokensSpent: number;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RunGraphNode {
  id: string;
  nodeId: string;
  type: string;
  title: string;
  status: NodeRunStatus;
  iteration: number;
  fanoutIndex: number;
  dynamic: boolean;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RunGraphEdge {
  id: string;
  from: string;
  to: string;
  when?: unknown;
}

export interface RunGraph {
  runId: string;
  status: RunStatus;
  nodeRuns: RunGraphNode[];
  edges: RunGraphEdge[];
}

export interface NodeRunDetail {
  id: string;
  runId: string;
  nodeId: string;
  type: string;
  title: string;
  assignee: string | null;
  engine: string | null;
  model: string | null;
  status: NodeRunStatus;
  iteration: number;
  fanoutIndex: number;
  dynamic: boolean;
  inputRef: string | null;
  outputRef: string | null;
  input: unknown;
  output: unknown;
  error: string | null;
  attempts: number;
  tokensSpent: number;
  startedAt: string | null;
  completedAt: string | null;
}

/** A run is "live" while pending/running/paused — poll it for fresh state. */
function isLive(status: RunStatus | undefined): boolean {
  return status === "running" || status === "pending" || status === "paused";
}

const LIVE_POLL_MS = 1500;

export function useRuns() {
  return useActionQuery("list-runs", {}) as {
    data?: RunListItem[];
    isLoading: boolean;
    error?: unknown;
  };
}

/**
 * The run console's primary source: the live graph. Polls while the run is live
 * so the node-status tints update without a manual refresh; `useDbSync` also
 * invalidates this query on any DB write, so polling is a belt-and-suspenders
 * fallback (FRONTEND §4 / real-time-sync skill).
 */
export function useRunGraph(runId: string | undefined) {
  return useActionQuery("run-graph", runId ? { runId } : { runId: "" }, {
    enabled: !!runId,
    refetchInterval: (query: { state: { data?: unknown } }) => {
      const data = query.state.data as RunGraph | undefined;
      return isLive(data?.status) ? LIVE_POLL_MS : false;
    },
  }) as { data?: RunGraph; isLoading: boolean; error?: unknown };
}

export function useRunGet(runId: string | undefined) {
  return useActionQuery("run-get", runId ? { runId } : { runId: "" }, {
    enabled: !!runId,
    refetchInterval: (query: { state: { data?: unknown } }) => {
      const data = query.state.data as { status?: RunStatus } | undefined;
      return isLive(data?.status) ? LIVE_POLL_MS : false;
    },
  }) as {
    data?: {
      runId: string;
      templateId: string;
      status: RunStatus;
      tokenBudget: number | null;
      tokensSpent: number;
      budgetRemaining: number | null;
      nodeRunCount: number;
      counts: Record<string, number>;
      startedAt: string | null;
      completedAt: string | null;
    };
    isLoading: boolean;
  };
}

export function useNodeRun(
  runId: string | undefined,
  nodeRunId: string | undefined,
) {
  return useActionQuery(
    "node-get",
    runId && nodeRunId ? { runId, nodeRunId } : { runId: "", nodeRunId: "" },
    { enabled: !!runId && !!nodeRunId },
  ) as { data?: NodeRunDetail; isLoading: boolean; error?: unknown };
}

function invalidateRun(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["action", "list-runs"] });
  qc.invalidateQueries({ queryKey: ["action", "run-graph"] });
  qc.invalidateQueries({ queryKey: ["action", "run-get"] });
  qc.invalidateQueries({ queryKey: ["action", "node-get"] });
}

/**
 * The run control verbs (FRONTEND §4 header). Each mutation invalidates the run
 * queries so the console reflects the new state immediately. `runAgain` starts
 * a fresh run from the run's template.
 */
export function useRunControls() {
  const qc = useQueryClient();
  const runStart = useActionMutation("run-start", {
    onSuccess: () => invalidateRun(qc),
  });
  const runPause = useActionMutation("run-pause", {
    onSuccess: () => invalidateRun(qc),
  });
  const runResume = useActionMutation("run-resume", {
    onSuccess: () => invalidateRun(qc),
  });
  const runCancel = useActionMutation("run-cancel", {
    onSuccess: () => invalidateRun(qc),
  });
  return { runStart, runPause, runResume, runCancel };
}
