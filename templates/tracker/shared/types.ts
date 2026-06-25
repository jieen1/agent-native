// Shared tracker types (UI + actions).

export type WorkItemType = "requirement" | "task" | "defect" | "incident";
export type WorkItemStatus =
  | "open"
  | "queued"
  | "running"
  | "dispatched"
  | "done"
  | "failed";

export interface Project {
  id: string;
  key: string;
  name: string;
  description: string;
  gitRemote: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkItem {
  id: string;
  projectId: string;
  type: WorkItemType | string;
  title: string;
  description: string;
  status: WorkItemStatus | string;
  priority: number;
  orchestratorThreadId?: string | null;
  orchestratorTaskId?: string | null;
  orchestratorRunId?: string | null;
  orchestratorWorkspaceId?: string | null;
  dispatchedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkItemDetail extends WorkItem {
  project: Pick<
    Project,
    "id" | "key" | "name" | "gitRemote" | "defaultBranch"
  > | null;
}

// A brain transcript event from the orchestrator (subset we render).
export interface BrainEvent {
  id: string;
  seq: number;
  type: string;
  text?: string | null;
  toolName?: string | null;
  createdAt?: string;
}

export interface BrainThread {
  id: string;
  title?: string | null;
  status?: string | null;
  workspaceId?: string | null;
  error?: string | null;
}

// One DAG node of a run (design / develop / review / commit …).
export interface OrchestratorRunNode {
  nodeIdInDag: string;
  type?: string | null;
  status: string;
  error?: string | null;
}

export interface OrchestratorRun {
  id: string;
  status: string;
  templateId?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  nodes?: OrchestratorRunNode[];
}

// The final delivery the brain produced (PR / branch / commit), surfaced so the
// tracker shows the loop's outcome without reading the whole transcript.
export interface Delivery {
  prUrl?: string | null;
  prNumber?: number | null;
  branch?: string | null;
  commit?: string | null;
}

// Live brain_task slot state for an item (the admission-gate row).
export interface BrainTaskSlot {
  status: string; // queued | running | done | failed | cancelled
  runId: string | null;
}

// Global concurrency-gate snapshot from brain-queue-status.
export interface BrainQueueStatus {
  brainConcurrency: number;
  running: number;
  queued: number;
  byStatus?: Record<string, number>;
  driverAlive?: boolean;
  lastTickAt?: string | null;
  reapsFired?: number;
  tasksPromoted?: number;
  lastError?: string | null;
}

export interface ActivityResponse {
  dispatched: boolean;
  threadId?: string;
  thread: BrainThread | null;
  events: BrainEvent[];
  runs: OrchestratorRun[];
  spawns: unknown[];
  delivery?: Delivery | null;
  slot?: BrainTaskSlot | null;
  itemStatus?: string;
  orchestratorRunId?: string | null;
  queue?: BrainQueueStatus | null;
  errors?: Record<string, string>;
}
