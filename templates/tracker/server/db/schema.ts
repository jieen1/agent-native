import {
  table,
  text,
  integer,
  ownableColumns,
  uniqueIndex,
} from "@agent-native/core/db/schema";

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
  stageGateConfig: text("stage_gate_config").notNull().default("{}"),
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
  // --- Additive v24 (F3 状态迁移守卫): dispatch-tracking + closure fields.
  // execState: null|queued|dispatched|running|returned — set by
  // dispatch-to-orchestrator on successful dispatch; NEVER used to advance
  // currentStageName (业务阶段不因派发而推进, 02 §8). Distinct from `status`
  // (open|queued|running|dispatched|done|failed|blocked|closed), which keeps
  // its pre-existing meaning for board rendering.
  execState: text("exec_state").default(null),
  // Set by transition-work-item when target=closed (未派发项人工关闭).
  closedReason: text("closed_reason").default(null),
  closedAt: text("closed_at").default(null),
  // --- Additive v25 (F5 任务拆分阈值/规划前置契约, 02 §3.10):
  // scaleEstimate: JSON {files,crossLifecycle,verdict,signals,at} written by
  // estimate-brief-scale.ts (and overlaid by scale-runtime-signal.ts's
  // runtime-exceeded path) — consumed by dispatch-to-orchestrator.ts's
  // pre-dispatch gate and the S2/S4 scale badge + warning bar.
  scaleEstimate: text("scale_estimate").default(null),
  // splitParentId: set on each child row by split-work-item.ts — points back
  // at the over-scale parent it was split from. Not a tracker_links edge
  // (unlike decompose-epic's child-of) because the relationship is 1:1 with
  // the row that created it, not a general graph edge.
  splitParentId: text("split_parent_id").default(null),
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
  // Single `phase` column reused by M1-7 (single-active-sprint / fine-grained
  // phase markers) and M1-8 (execution phase visibility). NOT NULL DEFAULT
  // 'planning' matches the v19 migration; values include planning | executing |
  // verifying | auditing | promoting | designing | storytelling | done.
  phase: text("phase").notNull().default("planning"),
  executorThreadId: text("executor_thread_id"),
  branch: text("branch").default(""),
  startDate: text("start_date").default(""),
  endDate: text("end_date").default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  // R4b.2 (Sprint Studio, r4-workflow-families-planning-skills.md §5.1): the
  // one genuinely-new column — manual step-rail overrides (activate/skip/mark
  // n/a) and UI prefs (e.g. problem-pool collapsed) that have no other home.
  // JSON-encoded (this schema has no native jsonb type; see `tags`/
  // `scaleEstimate` for the same text-column convention). Shape:
  // { stepOverrides?: Record<number, "in-progress"|"final"|"skipped"|"not-applicable">,
  //   problemPoolCollapsed?: boolean }
  studioState: text("studio_state").notNull().default("{}"),
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
  blockedBy: text("blocked_by").default("[]"),
  // v28 (03-tracker.md §8 队列与调度接真): manual drag/pin order within the
  // "可派发" group. On a genuinely fresh DB this column is nullable (null =
  // never reordered); on 101's production Postgres, v9's CREATE TABLE text
  // had already (undocumented, pre-v26 hash-guard) created this column as
  // `NOT NULL DEFAULT 0` for an unrelated legacy purpose — v28's `ADD COLUMN
  // IF NOT EXISTS` was a no-op there. app/lib/queue.ts's sortDispatchable
  // treats `position <= 0` as the "unordered" sentinel so both shapes work;
  // reorder-queue.ts assigns 1-based positions to keep 0 free as that
  // sentinel. waitingOn is the unified dependency-vs-health wait descriptor
  // (JSON `{type:'dependency'|'health', ...}`); blockedBy above is kept
  // (legacy reader) and written alongside it. healthCheckLog is the most
  // recent health-gate rejection for this row (JSON `{reason, at}`), written
  // by the scheduler-paused gate.
  position: integer("position"),
  waitingOn: text("waiting_on").default("{}"),
  healthCheckLog: text("health_check_log"),
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
// Approvals — gate sign-off records for plan/design/ui/escalation/audit-deferral.
//
// gateKey: 'plan-signoff' | 'design-signoff' | 'ui-signoff' | 'escalation' |
//   'audit-deferral' (see shared/types.ts's GateKey union + the zod enum on
//   request-approval.ts's schema for the actually-enforced list — this column
//   itself carries no DB-level constraint, plain text).
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
  anchorArtifactId: text("anchor_artifact_id").default(null),
  anchorVersion: integer("anchor_version").default(null),
  staleAt: text("stale_at").default(null),
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

// ---------------------------------------------------------------------------
// Work item documents — external docs (design / prototype / acceptance /
// spec / other) attached to a work item. Each row is one URL with a title
// and doc_type label.
// ---------------------------------------------------------------------------
export const workItemDocuments = table("tracker_work_item_documents", {
  id: text("id").primaryKey(),
  workItemId: text("work_item_id").notNull(),
  docType: text("doc_type").notNull().default("other"),
  title: text("title").notNull(),
  url: text("url").notNull(),
  createdAt: text("created_at").notNull(),
  ...ownableColumns(),
});

// ---------------------------------------------------------------------------
// Artifact reviews — v2.1 review three-question checkboxes per artifact
// version. Anchored to (artifactId, version) so that when a new artifact
// version is created, the new version starts with zero checked items
// (reset semantics achieved purely by query resolution, not migration).
// ---------------------------------------------------------------------------
export const artifactReviews = table(
  "tracker_artifact_reviews",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifact_id").notNull(),
    version: integer("version").notNull(),
    reviewKey: text("review_key").notNull(),
    checked: integer("checked").notNull().default(0),
    reviewer: text("reviewer").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    ...ownableColumns(),
  },
  (t) => ({
    artifactVersionKeyUnique: uniqueIndex(
      "tracker_artifact_reviews_artifact_version_key_idx",
    ).on(t.artifactId, t.version, t.reviewKey),
  }),
);

// ---------------------------------------------------------------------------
// F8: work item run history — 回链完整性. Append-only: every successful
// dispatch (single or bulk) INSERTs a new row rather than overwriting a
// single slot (SDLC-053 — a redispatch used to silently clobber the prior
// run's thread/branch, losing the earlier attempt's trail). A redispatch
// marks the item's prior non-superseded row(s) `superseded=1` and inserts a
// fresh row. `runId`/`branch` start null at dispatch time (only `threadId` is
// known immediately) and are backfilled once the bound DAG run starts and
// reports its branch (F9's writeback channel; see server/lib/work-item-runs.ts
// for the backfill function F9's action will call). UNIQUE(workItemId, runId)
// makes that backfill idempotent — re-reporting the same run is a no-op, not
// a duplicate row (T-F8-04). NULL runId rows (pre-backfill) never collide
// with each other under Postgres/SQLite unique-index NULL semantics.
// ---------------------------------------------------------------------------
export const workItemRuns = table(
  "tracker_work_item_runs",
  {
    id: text("id").primaryKey(),
    workItemId: text("work_item_id").notNull(),
    runId: text("run_id").default(null),
    threadId: text("thread_id").default(null),
    branch: text("branch").default(null),
    dispatchedAt: text("dispatched_at").notNull(),
    superseded: integer("superseded").notNull().default(0),
    createdAt: text("created_at").notNull(),
    ...ownableColumns(),
  },
  (t) => ({
    workItemRunUnique: uniqueIndex(
      "tracker_work_item_runs_work_item_run_idx",
    ).on(t.workItemId, t.runId),
  }),
);

// ---------------------------------------------------------------------------
// F8: itemKey allocation authority — the single project-level sequencer.
// Replaces the pre-F8 `count(*) + 1` allocation in create-work-item.ts and
// decompose-epic.ts (SDLC-038: concurrent creates raced on the same count and
// minted duplicate itemKeys). `nextSeq` holds the LAST issued number; the
// atomic allocator (server/lib/item-key-sequencer.ts) does
// `UPDATE ... SET next_seq = next_seq + 1 RETURNING next_seq` so each caller
// gets a unique, contiguous number even under real concurrency (T-F8-01).
// No ownable columns — this is an internal per-project counter, never queried
// directly with ownerScope (the owning project is already ownable).
// ---------------------------------------------------------------------------
export const projectSeq = table("tracker_project_seq", {
  projectId: text("project_id").primaryKey(),
  nextSeq: integer("next_seq").notNull(),
});
