// Shared tracker types (UI + actions).

export type WorkItemType =
  | "requirement"
  | "task"
  | "defect"
  | "incident"
  | "epic";
export type WorkItemStatus =
  | "open"
  | "queued"
  | "running"
  | "dispatched"
  | "blocked"
  // F3: run came back (slot terminal-success / delivered PR) — review
  // pending. The poll writeback caps here; done is human-guarded only.
  | "returned"
  | "done"
  | "failed"
  // F3: written by transition-work-item(target=closed) — 未派发项人工关闭.
  | "closed";

// F3 状态迁移守卫 — the 7 guard-facing target states (see
// server/lib/transition-guard.ts on the server side; this is the client-side
// mirror of the SAME vocabulary, not a re-implementation of the guard logic
// itself — the actual legality always comes from get-work-item's
// `allowedTransitions`, computed server-side).
export type GuardState =
  | "待办"
  | "实施"
  | "测试"
  | "待人工评审"
  | "交付"
  | "done"
  | "closed";

/** One legal target the current user could pick in the GuardedTransitionDialog
 *  Select, with the evidence fields the S4 dialog should render for it. Mirrors
 *  server/lib/transition-guard.ts's TransitionDescriptor (ok=true entries only —
 *  get-work-item's allowedTransitions already filters to legal targets). */
export interface TransitionOption {
  target: GuardState;
  need: string[];
  summary: string;
  kind:
    | "noop"
    | "terminal-done"
    | "terminal-closed"
    | "escape-delivery"
    | "manual-override"
    | "forward-blocked"
    | "blocked-terminal";
}

// F5 (v25): scale_estimate JSON shape — see server/lib/scale-estimate.ts.
export interface ScaleEstimate {
  files: number;
  crossLifecycle: boolean;
  signals: string[];
  verdict: "ok" | "split-required";
  at?: string;
}

export interface Project {
  id: string;
  key: string;
  name: string;
  description: string;
  gitRemote: string;
  defaultBranch: string;
  stageGateConfig?: string;
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
  // F5 (v25): present on list-work-items rows (board-level scale badge).
  scaleEstimate?: ScaleEstimate | null;
  splitParentId?: string | null;
}

// F8 (回链完整性): one row of a work item's dispatch/run history, newest
// first. A redispatch appends a new row rather than overwriting the previous
// one (SDLC-053) — `superseded` marks all but the current live row.
export interface WorkItemRunSummary {
  runId: string | null;
  threadId: string | null;
  branch: string | null;
  dispatchedAt: string;
  superseded: boolean;
}

export interface WorkItemDetail extends WorkItem {
  sprintId?: string | null;
  itemKey?: string;
  // F8: itemKey 消歧(读路径) — the raw itemKey, or itemKey + '·' + short id
  // suffix when it collides with a sibling in the same project (historical
  // duplicates, SDLC-032~036). Always prefer this over `itemKey` for display.
  itemKeyDisplay?: string;
  // F8 (回链完整性): full dispatch/run history — see WorkItemRunSummary.
  runs?: WorkItemRunSummary[];
  risk?: string;
  tags?: string[];
  executionMode?: string;
  currentStageName?: string;
  plannedStages?: string[];
  branch?: string | null;
  owner?: string | null;
  nature?: string[];
  sprint?: { id: string; name: string; status: string } | null;
  project: Pick<
    Project,
    "id" | "key" | "name" | "gitRemote" | "defaultBranch"
  > | null;
  // F3 (v24): dispatch-tracking + closure fields — see server/db/schema.ts.
  execState?: string | null;
  closedReason?: string | null;
  closedAt?: string | null;
  // F3 (T-F3-08): server-computed legal targets for the current user —
  // consume directly, never re-derive the guard table client-side.
  allowedTransitions?: TransitionOption[];
  // F5 (v25, 02 §3.10 拆分契约): scale estimate (already parsed by
  // get-work-item.ts — a JSON object here, not a raw string) + the pointer
  // back to the parent this item was split from (if any).
  scaleEstimate?: ScaleEstimate | null;
  splitParentId?: string | null;
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

export type ItemType = "需求" | "任务" | "缺陷" | "测试" | "生产问题" | "集合";
export type ItemRisk = "low" | "medium" | "high";
export type ExecutionMode = "manual" | "auto";
export type SprintStatus = "规划" | "进行中" | "已完成" | "已发布";
export type SprintPhase = "planning" | "executing" | "done";
export type StageStatus = "待执行" | "执行中" | "已完成" | "已驳回" | "跳过";
export type StageName =
  | "待办"
  | "分析"
  | "设计"
  | "实施"
  | "测试"
  | "验收"
  | "交付";
export const STAGE_ORDER: StageName[] = [
  "待办",
  "分析",
  "设计",
  "实施",
  "测试",
  "验收",
  "交付",
];

export interface Sprint {
  id: string;
  projectId: string;
  name: string;
  goal: string;
  status: SprintStatus | string;
  phase: SprintPhase | string;
  executorThreadId?: string | null;
  branch: string;
  startDate: string;
  endDate: string;
  createdAt: string;
  updatedAt: string;
  itemCount?: number;
  delivered?: number;
}
export interface SprintDetail extends Sprint {
  items: TrackerWorkItem[];
  itemCount: number;
  delivered: number;
  stages: Stage[];
}
export interface TrackerWorkItem {
  id: string;
  projectId: string;
  sprintId: string | null;
  itemKey: string;
  itemKeyDisplay?: string;
  type: ItemType | string;
  title: string;
  description: string;
  status: string;
  priority: number;
  risk: ItemRisk | string;
  tags: string[];
  executionMode: ExecutionMode;
  currentStageName: StageName | string;
  plannedStages: string[];
  branch: string | null;
  orchestratorThreadId: string | null;
  createdAt: string;
  updatedAt: string;
  // F5 (v25): get-sprint.ts returns raw DB rows (unlike get-work-item.ts,
  // which parses) — scaleEstimate arrives as a raw JSON string (or null),
  // parse defensively at the point of use (matches how this codebase already
  // treats plannedStages/tags/nature off get-sprint's raw items).
  scaleEstimate?: string | null;
  splitParentId?: string | null;
  // S1 board card fields (list-work-items.ts) — optional because get-sprint's
  // items (also typed TrackerWorkItem) do not select these columns.
  owner?: string | null;
  orchestratorRunId?: string | null;
  dispatchedAt?: string | null;
}
export interface Stage {
  id: string;
  workItemId: string;
  stageName: StageName | string;
  stageStatus: StageStatus | string;
  deliveryItems: string[];
  verdict: {
    result: "通过" | "驳回";
    reason: string;
    rootCauseStage: string;
  } | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Artifact {
  id: string;
  workItemId: string;
  stageId: string;
  stageName: string;
  kind: string;
  name: string;
  version: number;
  contentRef: string;
  producedByKind: "agent" | "human";
  supersedes: string | null;
  createdAt: string;
}
export interface TrackerActivity {
  id: string;
  workItemId: string;
  actorKind: "agent" | "human";
  actorName: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
export interface TrackerComment {
  id: string;
  workItemId: string;
  authorKind: "agent" | "human";
  authorName: string;
  body: string;
  createdAt: string;
}
export interface ItemLink {
  id: string;
  fromItemId: string;
  toItemId: string;
  linkType: string;
  otherItemId: string;
  otherItemTitle: string;
  direction: "from" | "to";
}
export interface QueueItem {
  id: string;
  workItemId: string;
  priority: number;
  status: string;
  currentStage: string;
  enqueuedAt: string;
  startedAt: string | null;
  blockedBy?: string | null;
  workItem: TrackerWorkItem;
}
export interface QueueStats {
  queued: number;
  running: number;
  paused: number;
}

// Approval types (M1-3).
export type ApprovalStatus = "pending" | "approved" | "rejected";
export type GateKey =
  | "plan-signoff"
  | "design-signoff"
  | "escalation"
  | "audit-deferral";

export const GATE_KEY_LABELS: Record<GateKey, string> = {
  "plan-signoff": "计划签批",
  "design-signoff": "设计签批",
  escalation: "升级审批",
  "audit-deferral": "审计推迟",
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

// Review checklist types (F6 gate criteria, S5 门判据 panel) — mirrors
// server/lib/review-checklist.ts's ChecklistItem/ChecklistState shapes so the
// client can render get-review-checklist's result without `any`.
export type ChecklistItemSource = "machine" | "human";
export type ChecklistItemState = "pass" | "fail" | "needs-human";

export interface ChecklistItem {
  key: string;
  label: string;
  source: ChecklistItemSource;
  state: ChecklistItemState;
  detail?: string;
  checked: boolean;
}

export interface ReviewChecklistResult {
  workItemId: string;
  artifactId: string | null;
  version: number | null;
  complete: boolean;
  items: ChecklistItem[];
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

// Epic decomposition types (M1-4).

export interface DecomposeEpicChildInput {
  title: string;
  description?: string;
  repoName?: string;
  dependsOnTitles?: string[];
}

export interface DecomposeEpicResultChild {
  id: string;
  title: string;
  itemKey?: string;
  created: boolean;
}

export interface DecomposeEpicResult {
  epicId: string;
  children: DecomposeEpicResultChild[];
}

export interface EpicChildItem {
  id: string;
  itemKey?: string;
  // F8: itemKey 消歧(读路径) — see WorkItemDetail.itemKeyDisplay.
  itemKeyDisplay?: string;
  title: string;
  status: string;
  currentStageName?: string;
  priority: number;
}

export interface EpicChildDependency {
  fromId: string;
  toId: string;
  fromLabel: string;
  toLabel: string;
}

export interface EpicChildrenResult {
  children: EpicChildItem[];
  dependencies: EpicChildDependency[];
}

// Dependency-graph validation (M1-5): validate-dependency-graph action result.
export interface GraphValidationIssue {
  code:
    | "self-dependency"
    | "cycle"
    | "chain-too-deep"
    | "no-parallelism"
    | "orphan";
  message: string;
  path?: string[];
}
export interface GraphValidationResult {
  errors: GraphValidationIssue[];
  warnings: GraphValidationIssue[];
  topoOrder: string[];
}

// Stage gate criteria for advance-stage (M1-6).
export interface StageGateCriteria {
  requireArtifacts?: string[]; // docKeys that must exist in tracker_sprint_artifacts for the item's sprint
  requireApproval?: string; // gateKey that must have an 'approved' tracker_approvals row for the item's sprint
  requireGraphValid?: boolean; // dependency graph (scoped to item's sprint, else project) must have zero errors
}
export type StageGateConfig = Record<string, StageGateCriteria>;

export interface AdvanceStageResult {
  noop?: boolean;
  blocked?: boolean;
  missing?: string[];
  workItemId?: string;
  stageName?: string;
  cascaded?: { workItemId: string; ok: boolean; error?: string }[];
}

// Inbox types (R3) — see server/lib/inbox.ts (single query source, shared by
// list-inbox.ts and view-screen.ts) for which groups are backed by real data.
export type InboxGroupKey =
  | "signoff"
  | "escalation"
  | "reviewRequest"
  | "failedRouting"
  | "notifications";

export interface InboxRow {
  id: string;
  group: InboxGroupKey;
  /** gateKey for approval rows, "review-request" / "failed" for work-item rows. */
  kind: string;
  title: string;
  summary: string;
  status: string;
  /** ISO timestamp — the UI derives "相对时间" from this. */
  timestamp: string;
  approvalId?: string;
  gateKey?: GateKey | string;
  /** Optional JSON `{runId, nodeId}` — set when the gate was requested with a
   *  reference to the orchestrator run/node it blocks (escalation rows). */
  gateRef?: string | null;
  workItemId?: string;
  sprintId?: string | null;
  itemKey?: string;
  itemKeyDisplay?: string;
  projectId?: string;
  currentStageName?: string;
  branch?: string | null;
  requestedBy?: string;
}

export interface InboxGroups {
  signoff: InboxRow[];
  escalation: InboxRow[];
  reviewRequest: InboxRow[];
  failedRouting: InboxRow[];
  notifications: InboxRow[];
}

export interface InboxCounts {
  signoff: number;
  escalation: number;
  reviewRequest: number;
  failedRouting: number;
  notifications: number;
  total: number;
}

export interface InboxResult {
  groups: InboxGroups;
  counts: InboxCounts;
}
