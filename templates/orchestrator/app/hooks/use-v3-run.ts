import { useActionQuery } from "@agent-native/core/client";

/**
 * V3 Run Detail types and hooks.
 *
 * Driven by useActionQuery over the v3-runs and v3-run-detail actions.
 * Polls while the run is in a live state (running/pending/paused).
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type V3RunStatus =
  | "pending"
  | "running"
  | "paused"
  | "done"
  | "failed"
  | "cancelled";

export type V3NodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "done"
  | "failed"
  | "skipped"
  | "awaiting-approval";

export interface V3RunState {
  id: string;
  templateId: string | null;
  templateVersion: number | null;
  status: V3RunStatus;
  priority: number;
  tags: unknown;
  dagVersion: number;
  startedAt: string | null;
  completedAt: string | null;
  nodeCounts: Record<string, number>;
  totalNodes: number;
}

export interface V3Node {
  id: string;
  runId: string;
  nodeIdInDag: string;
  type: string;
  status: V3NodeStatus;
  iteration: number;
  fanoutIndex: number;
  currentSpawnId: string | null;
  outputArtifactId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export interface V3DagNode {
  id: string;
  type: string;
  deps?: string[];
  [key: string]: unknown;
}

export interface V3DagEdge {
  from: string;
  to: string;
}

export interface V3DagDefinition {
  nodes: V3DagNode[];
  edges: V3DagEdge[];
  dagVersion: number;
}

export interface V3Patch {
  id: string;
  dagVersionBefore: number;
  dagVersionAfter: number;
  patchOps: unknown;
  actor: string;
  reason: string | null;
  applied: boolean;
  appliedAt: string | null;
}

export interface V3Event {
  id: string;
  kind: string;
  payload: unknown;
  seqNum: number | null;
  ts: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isLive(status: V3RunStatus | undefined): boolean {
  return status === "running" || status === "pending" || status === "paused";
}

const LIVE_POLL_MS = 1500;

// ── Hooks ────────────────────────────────────────────────────────────────────

export function useV3RunState(runId: string | undefined) {
  return useActionQuery(
    "runState" as any,
    runId ? { runId } : { runId: "" },
    {
      enabled: !!runId,
      refetchInterval: (query: { state: { data?: unknown } }) => {
        const data = query.state.data as V3RunState | undefined;
        return isLive(data?.status) ? LIVE_POLL_MS : false;
      },
    },
  ) as {
    data?: V3RunState;
    isLoading: boolean;
    error?: unknown;
  };
}

export function useV3RunNodes(runId: string | undefined) {
  return useActionQuery(
    "v3RunNodes" as any,
    runId ? { runId } : { runId: "" },
    {
      enabled: !!runId,
      refetchInterval: (query: { state: { data?: unknown } }) => {
        const hasRunning = (query.state.data as V3Node[] | undefined)?.some(
          (n) => n.status === "running" || n.status === "ready",
        );
        return hasRunning ? LIVE_POLL_MS : false;
      },
    },
  ) as { data?: V3Node[]; isLoading: boolean; error?: unknown };
}

export function useV3RunDag(runId: string | undefined) {
  return useActionQuery(
    "v3RunDag" as any,
    runId ? { runId } : { runId: "" },
    {
      enabled: !!runId,
    },
  ) as {
    data?: V3DagDefinition;
    isLoading: boolean;
    error?: unknown;
  };
}

export function useV3RunPatches(runId: string | undefined) {
  return useActionQuery(
    "v3RunPatches" as any,
    runId ? { runId } : { runId: "" },
    {
      enabled: !!runId,
    },
  ) as { data?: V3Patch[]; isLoading: boolean; error?: unknown };
}

export function useV3RunEvents(runId: string | undefined) {
  return useActionQuery(
    "v3RunEvents" as any,
    runId ? { runId } : { runId: "" },
    {
      enabled: !!runId,
    },
  ) as { data?: V3Event[]; isLoading: boolean; error?: unknown };
}
