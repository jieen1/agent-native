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

// ── Per-node detail ──────────────────────────────────────────────────────────

/**
 * Spawn metadata surfaced through `nodeSummary` — who ran the node, with which
 * model/runtime, and what it cost.
 */
export interface V3NodeSpawn {
  id: string;
  agentName: string | null;
  runtime: string | null;
  engineRef: string | null;
  modelRef: string | null;
  status: string;
  tokensInput: number;
  tokensOutput: number;
  latencyMs: number | null;
  error: string | null;
  errorClass: string | null;
}

/**
 * Full per-node detail joined from node → spawn → output artifact. This is the
 * cleanest single read for "agent + model + tokens + time + output text".
 */
export interface V3NodeSummary {
  nodeId: string;
  runId: string;
  nodeIdInDag: string;
  type: string;
  status: V3NodeStatus;
  iteration: number;
  fanoutIndex: number;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  output: string | null;
  outputKind: string | null;
  truncated: boolean;
  spawn: V3NodeSpawn | null;
}

/**
 * One ordered step in a spawn's INTERMEDIATE execution transcript — assistant
 * reasoning `text`, a `tool_use` (name + input), or a `tool_result` (name +
 * result). Drives the Node Inspector "执行过程 / Execution" timeline.
 */
export interface V3SpawnEvent {
  id: string;
  seq: number;
  /** "text" | "tool_use" | "tool_result" */
  type: string;
  name: string | null;
  input: unknown;
  result: unknown;
  text: string | null;
}

/** Result shape of the `spawnEvents` action. */
export interface V3SpawnEventsResult {
  spawnId: string;
  runId: string | null;
  status: string;
  events: V3SpawnEvent[];
  total: number;
}

/** Detailed spawn read (adds the rendered prompt + full log to the summary). */
export interface V3SpawnDetail {
  id: string;
  agentName: string | null;
  modelRef: string | null;
  engineRef: string | null;
  runtime: string | null;
  workspaceId: string | null;
  renderedPrompt: string;
  status: string;
  tokensInput: number;
  tokensOutput: number;
  latencyMs: number | null;
  output?: string | null;
  log?: string | null;
  error: string | null;
}

/** Aggregate roll-up of a run: node counts + total token usage. */
export interface V3RunRollup {
  runId: string;
  status: V3RunStatus;
  templateId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  nodes: {
    total: number;
    done: number;
    failed: number;
    skipped: number;
    running: number;
    pending: number;
    awaitingApproval: number;
    ready: number;
  };
  tokens: {
    input: number;
    output: number;
    total: number;
    spawnCount: number;
  };
}

/** Fetch the run roll-up (total tokens, node counts) via `runSummary`. */
export function useV3RunSummary(runId: string | undefined) {
  return useActionQuery(
    "runSummary" as any,
    { runId: runId ?? "" },
    {
      enabled: !!runId,
      refetchInterval: (query: { state: { data?: unknown } }) => {
        const data = query.state.data as V3RunRollup | undefined;
        return isLive(data?.status) ? LIVE_POLL_MS : false;
      },
    },
  ) as { data?: V3RunRollup; isLoading: boolean; error?: unknown };
}

/** Fetch the full summary for one node (agent, model, tokens, time, output). */
export function useV3NodeSummary(
  runId: string | undefined,
  nodeId: string | null | undefined,
) {
  return useActionQuery(
    "nodeSummary" as any,
    { runId: runId ?? "", nodeId: nodeId ?? "" },
    {
      enabled: !!runId && !!nodeId,
    },
  ) as { data?: V3NodeSummary; isLoading: boolean; error?: unknown };
}

/** Fetch a single spawn's detail — used for the rendered prompt. */
export function useV3SpawnDetail(spawnId: string | null | undefined) {
  return useActionQuery(
    "spawnGet" as any,
    { spawnId: spawnId ?? "" },
    {
      enabled: !!spawnId,
    },
  ) as { data?: V3SpawnDetail; isLoading: boolean; error?: unknown };
}

/**
 * Fetch a spawn's INTERMEDIATE execution transcript (reasoning + tool calls +
 * results) for the Node Inspector execution timeline. Polls while the spawn is
 * still running so a live node fills in its steps; stops once terminal.
 */
export function useV3SpawnEvents(spawnId: string | null | undefined) {
  return useActionQuery(
    "spawnEvents" as any,
    { spawnId: spawnId ?? "" },
    {
      enabled: !!spawnId,
      refetchInterval: (query: { state: { data?: unknown } }) => {
        const data = query.state.data as V3SpawnEventsResult | undefined;
        return data?.status === "running" || data?.status === "pending"
          ? LIVE_POLL_MS
          : false;
      },
    },
  ) as { data?: V3SpawnEventsResult; isLoading: boolean; error?: unknown };
}
