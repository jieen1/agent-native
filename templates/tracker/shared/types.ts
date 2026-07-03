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
  sprintId?: string | null;
  itemKey?: string;
  risk?: string;
  tags?: string[];
  executionMode?: string;
  currentStageName?: string;
  plannedStages?: string[];
  branch?: string | null;
  sprint?: { id: string; name: string; status: string } | null;
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

// Sprint / stage / artifact tracker types.

export type ItemType = '需求' | '任务' | '缺陷' | '测试' | '生产问题';
export type ItemRisk = 'low' | 'medium' | 'high';
export type ExecutionMode = 'manual' | 'auto';
export type SprintStatus = '规划' | '进行中' | '已完成' | '已发布';
export type StageStatus = '待执行' | '执行中' | '已完成' | '已驳回' | '跳过';
export type StageName = '待办' | '分析' | '设计' | '实施' | '测试' | '验收' | '交付';
export const STAGE_ORDER: StageName[] = ['待办','分析','设计','实施','测试','验收','交付'];

export interface Sprint { id:string; projectId:string; name:string; goal:string; status:SprintStatus|string; branch:string; startDate:string; endDate:string; createdAt:string; updatedAt:string; itemCount?:number; delivered?:number; }
export interface SprintDetail extends Sprint { items: TrackerWorkItem[]; itemCount: number; delivered: number; stages: Stage[]; }
export interface TrackerWorkItem { id:string; projectId:string; sprintId:string|null; itemKey:string; type:ItemType|string; title:string; description:string; status:string; priority:number; risk:ItemRisk|string; tags:string[]; executionMode:ExecutionMode; currentStageName:StageName|string; plannedStages:string[]; branch:string|null; orchestratorThreadId:string|null; createdAt:string; updatedAt:string; }
export interface Stage { id:string; workItemId:string; stageName:StageName|string; stageStatus:StageStatus|string; deliveryItems:string[]; verdict:{result:'通过'|'驳回';reason:string;rootCauseStage:string}|null; startedAt:string|null; completedAt:string|null; createdAt:string; updatedAt:string; }
export interface Artifact { id:string; workItemId:string; stageId:string; stageName:string; kind:string; name:string; version:number; contentRef:string; producedByKind:'agent'|'human'; supersedes:string|null; createdAt:string; }
export interface TrackerActivity { id:string; workItemId:string; actorKind:'agent'|'human'; actorName:string; eventType:string; payload:Record<string,unknown>; createdAt:string; }
export interface TrackerComment { id:string; workItemId:string; authorKind:'agent'|'human'; authorName:string; body:string; createdAt:string; }
export interface ItemLink { id:string; fromItemId:string; toItemId:string; linkType:string; otherItemId:string; otherItemTitle:string; direction:'from'|'to'; }
export interface QueueItem { id:string; workItemId:string; priority:number; status:string; currentStage:string; enqueuedAt:string; startedAt:string|null; workItem:TrackerWorkItem; }
export interface QueueStats { queued:number; running:number; paused:number; }

// Approval types (M1-3).
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export type GateKey = 'plan-signoff' | 'design-signoff' | 'escalation' | 'audit-deferral';

export const GATE_KEY_LABELS: Record<GateKey, string> = {
  'plan-signoff': '计划签批',
  'design-signoff': '设计签批',
  'escalation': '升级审批',
  'audit-deferral': '审计推迟',
};

export interface Approval {
  id: string;
  sprintId: string;
  workItemId: string | null;
  gateKey: GateKey | string;
  gateRef: string | null;
  status: ApprovalStatus | string;
  requestedBy: string;
  decidedBy: string | null;
  reason: string | null;
  decidedAt: string | null;
  createdAt: string;
}

// Sprint artifact types (M1-2).
export interface SprintArtifact {
  id: string;
  sprintId: string;
  docKey: string;
  kind: string;
  name: string;
  version: number;
  supersedes: string | null;
  producedByKind: "agent" | "human";
  content: string;
  contentRef: string | null;
  createdAt: string;
}
export interface SprintArtifactsByDocKey {
  byDocKey: Record<string, SprintArtifact[]>;
}
