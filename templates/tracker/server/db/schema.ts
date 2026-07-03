import { table, text, integer, ownableColumns } from "@agent-native/core/db/schema";

// ---------------------------------------------------------------------------
// Tracker schema (minimal viable slice of docs/v1-DESIGN.md §3).
//
// Two tables: projects (repo/branch configured ONCE per project) and
// work_items (a unit of work — a requirement/task/defect — that carries a
// requirement and, when dispatched, the orchestrator brain thread id).
//
// Additive only. The deployment runs these against the shared Postgres via
// DATABASE_URL; the same Drizzle schema also works on LibSQL in local dev.
// ---------------------------------------------------------------------------

export const projects = table("tracker_projects", {
  id: text("id").primaryKey(),
  // Short id prefix shown on the board, e.g. "PAY" -> "PAY-14".
  key: text("key").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  // Repo + branch are configured ONCE here and carried on every dispatch.
  gitRemote: text("git_remote").notNull().default(""),
  defaultBranch: text("default_branch").notNull().default("main"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  ...ownableColumns(),
});

export const workItems = table("tracker_work_items", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  // requirement | task | defect | incident
  type: text("type").notNull().default("requirement"),
  title: text("title").notNull(),
  // The free-form requirement / description handed to the orchestrator brain.
  description: text("description").notNull().default(""),
  // Lifecycle, widened to reflect the orchestrator's live admission gate:
  // open | queued | running | dispatched | done | failed. `queued`/`running`
  // mirror the brain_task slot state so the board shows the concurrency gate.
  status: text("status").notNull().default("open"),
  priority: integer("priority").notNull().default(0),
  // Set on dispatch: the orchestrator brain thread powering this item's work.
  orchestratorThreadId: text("orchestrator_thread_id"),
  // The orchestrator brain_task id (the admission-gate row). Lets the tracker
  // read this item's slot state (queued → running → done) without the thread.
  orchestratorTaskId: text("orchestrator_task_id"),
  // The bound DAG/workflow run id once the brain starts executing (for display
  // and to confirm a real run reached terminal → slot released).
  orchestratorRunId: text("orchestrator_run_id"),
  // Echo of the workspace the brain provisioned for the dispatch (for display).
  orchestratorWorkspaceId: text("orchestrator_workspace_id"),
  dispatchedAt: text("dispatched_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  ...ownableColumns(),
  // --- Additive columns: sprint binding, item keying, risk, tags, execution.
  sprintId: text("sprint_id").default(null),
  itemKey: text("item_key").notNull().default(""),
  risk: text("risk").notNull().default("medium"),
  tags: text("tags").notNull().default("[]"),
  executionMode: text("execution_mode").notNull().default("manual"),
  plannedStages: text("planned_stages").notNull().default("[]"),
  currentStageName: text("current_stage_name").notNull().default("待办"),
  branch: text("branch").default(null),
  // --- Additive v2: owner (负责人) and nature tags (性质: 前端/后端/API/数据).
  // owner = email or "agent" (显示: 智能体). null = unassigned.
  owner: text("owner").default(null),
  // nature = JSON array of tags from set: 前端 | 后端 | API | 数据
  nature: text("nature").notNull().default("[]"),
});

// ---------------------------------------------------------------------------
// Sprints — a named time-box that groups work items together.
//
// Each sprint owns a goal, a status (规划/进行中/已完成), and the git branch
// the work targets. startDate / endDate are ISO-8601 strings; null means
// rolling / not yet planned.
// ---------------------------------------------------------------------------
export const sprints = table("tracker_sprints", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  name: text("name").notNull(),
  goal: text("goal").default(""),
  status: text("status").default("规划"),
  branch: text("branch").default(""),
  startDate: text("start_date").default(""),
  endDate: text("end_date").default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  ...ownableColumns(),
});

// ---------------------------------------------------------------------------
// Stages — the sequential execution phases of a work item (e.g. 待办 → 开发
// → 测试 → 完成). Each stage tracks its own status, the delivery artifacts it
// produces, the workflow-run ref that drove it, and a final verdict.
// ---------------------------------------------------------------------------
export const stages = table("tracker_stages", {
  id: text("id").primaryKey(),
  workItemId: text("work_item_id").notNull(),
  stageName: text("stage_name").notNull(),
  stageStatus: text("stage_status").default("待执行"),
  deliveryItems: text("delivery_items").default("[]"),
  workflowRunRef: text("workflow_run_ref").default(null),
  verdict: text("verdict").default(null),
  startedAt: text("started_at").default(null),
  completedAt: text("completed_at").default(null),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  ...ownableColumns(),
});

// ---------------------------------------------------------------------------
// Artifacts — durable outputs produced by a stage (code, docs, reports, …).
//
// Each artifact records its kind (code / doc / report / …), a human-readable
// name, a monotonic version, who produced it (agent vs. human), an optional
// content ref, and the supersedes link so old artifacts are traceable.
// ---------------------------------------------------------------------------
export const artifacts = table("tracker_artifacts", {
  id: text("id").primaryKey(),
  workItemId: text("work_item_id").notNull(),
  stageId: text("stage_id").notNull(),
  stageName: text("stage_name").notNull(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  version: integer("version").default(1),
  contentRef: text("content_ref").default(""),
  producedByKind: text("produced_by_kind").default("agent"),
  supersedes: text("supersedes").default(null),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  ...ownableColumns(),
});

// ---------------------------------------------------------------------------
// Activities — an append-only audit log of everything that happened to a work
// item: dispatches, stage transitions, verdicts, retries, …
//
// payload is a JSON-encoded blob; eventType is the machine-readable
// identifier (e.g. "stage.started", "verdict.passed").
// ---------------------------------------------------------------------------
export const activities = table("tracker_activities", {
  id: text("id").primaryKey(),
  workItemId: text("work_item_id").notNull(),
  actorKind: text("actor_kind").default("agent"),
  actorName: text("actor_name").default("智能体"),
  eventType: text("event_type").notNull(),
  payload: text("payload").default("{}"),
  createdAt: text("created_at").notNull(),
  ...ownableColumns(),
});

// ---------------------------------------------------------------------------
// Comments — human (or agent-as-human) notes attached to a work item.
// ---------------------------------------------------------------------------
export const comments = table("tracker_comments", {
  id: text("id").primaryKey(),
  workItemId: text("work_item_id").notNull(),
  authorKind: text("author_kind").default("human"),
  authorName: text("author_name").default(""),
  body: text("body").notNull(),
  createdAt: text("created_at").notNull(),
  ...ownableColumns(),
});

// ---------------------------------------------------------------------------
// Links — typed, directed edges between work items (e.g. blocks, depends-on,
// relates-to). Both endpoints are other work item ids in the same project.
// ---------------------------------------------------------------------------
export const links = table("tracker_links", {
  id: text("id").primaryKey(),
  fromItemId: text("from_item_id").notNull(),
  toItemId: text("to_item_id").notNull(),
  linkType: text("link_type").notNull(),
  createdAt: text("created_at").notNull(),
  ...ownableColumns(),
});

// ---------------------------------------------------------------------------
// Rollback log — an audit trail of stage reversions (e.g. 开发 → 待办 after a
// failed test). Every rollback records from/to stage, reason, and who did it.
// ---------------------------------------------------------------------------
export const rollbackLog = table("tracker_rollback_log", {
  id: text("id").primaryKey(),
  workItemId: text("work_item_id").notNull(),
  fromStage: text("from_stage").notNull(),
  toStage: text("to_stage").notNull(),
  reason: text("reason").default(""),
  byKind: text("by_kind").default("agent"),
  createdAt: text("created_at").notNull(),
  ...ownableColumns(),
});

// ---------------------------------------------------------------------------
// Execution queue — the admission-gate backlog that the orchestrator pulls
// from. Each work item appears at most once; priority + status drive ordering.
// ---------------------------------------------------------------------------
export const execQueue = table("tracker_exec_queue", {
  id: text("id").primaryKey(),
  workItemId: text("work_item_id").notNull().unique(),
  priority: integer("priority").default(0),
  status: text("status").default("queued"),
  currentStage: text("current_stage").default(""),
  enqueuedAt: text("enqueued_at").notNull(),
  startedAt: text("started_at").default(null),
  ...ownableColumns(),
});

// ---------------------------------------------------------------------------
// Project repos — each project can register multiple code repositories.
// Mirrors design project.yaml repos[] — name is unique within a project.
// ciMode: 'none' | 'github'; gateMode: 'tests-only' | 'stack' | 'none'
// buildTool: free text (e.g. 'npm', 'pnpm', 'gradle').
// devModel: optional model override for agent work on this repo.
// ---------------------------------------------------------------------------
export const projectRepos = table("tracker_project_repos", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  // Short repo name, unique within a project (e.g. "demo-app").
  name: text("name").notNull(),
  gitRemote: text("git_remote").notNull().default(""),
  baseBranch: text("base_branch").notNull().default("main"),
  testCmdUnit: text("test_cmd_unit").notNull().default(""),
  testCmdFull: text("test_cmd_full").notNull().default(""),
  e2eTestPath: text("e2e_test_path").notNull().default(""),
  integrationTestPath: text("integration_test_path").notNull().default(""),
  buildTool: text("build_tool").notNull().default(""),
  // CI/CD integration mode.
  ciMode: text("ci_mode").notNull().default("none"),
  // Gate strategy used when dispatching work on this repo.
  gateMode: text("gate_mode").notNull().default("tests-only"),
  // Optional model override for agent-driven work on this repo.
  devModel: text("dev_model"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  ...ownableColumns(),
});

// ---------------------------------------------------------------------------
// Approvals — gate sign-off records for plan/design/escalation/audit-deferral.
//
// gateKey: 'plan-signoff' | 'design-signoff' | 'escalation' | 'audit-deferral'
// gateRef: optional JSON {runId, nodeId} linking to an orchestrator workflow gate.
// status: 'pending' | 'approved' | 'rejected'
// Idempotency: at most one pending row per (sprintId, gateKey, workItemId).
// ---------------------------------------------------------------------------
export const approvals = table("tracker_approvals", {
  id: text("id").primaryKey(),
  sprintId: text("sprint_id").notNull(),
  workItemId: text("work_item_id").default(null),
  gateKey: text("gate_key").notNull(),
  gateRef: text("gate_ref").default(null),
  status: text("status").notNull().default("pending"),
  requestedBy: text("requested_by").notNull(),
  decidedBy: text("decided_by").default(null),
  reason: text("reason").default(null),
  decidedAt: text("decided_at").default(null),
  createdAt: text("created_at").notNull(),
  ...ownableColumns(),
});

// ---------------------------------------------------------------------------
// Sprint artifacts — sprint-level versioned documents.
// docKey examples: sprint-doc | test-plan | tech-design | brief:{itemKey} |
//   shared-brief | audit-report:{n} | story | verify-report
// Each (sprintId, docKey) pair has its own monotonic version chain; supersedes
// points to the immediately preceding artifact id.
// producedByKind: 'agent' | 'human' — human-protection enforced in the action.
// ---------------------------------------------------------------------------
export const sprintArtifacts = table("tracker_sprint_artifacts", {
  id: text("id").primaryKey(),
  sprintId: text("sprint_id").notNull(),
  docKey: text("doc_key").notNull(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  version: integer("version").notNull().default(1),
  supersedes: text("supersedes").default(null),
  producedByKind: text("produced_by_kind").notNull().default("agent"),
  content: text("content").notNull().default(""),
  contentRef: text("content_ref").default(null),
  createdAt: text("created_at").notNull(),
  ...ownableColumns(),
});
