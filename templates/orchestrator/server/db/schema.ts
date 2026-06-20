import {
  table,
  text,
  integer,
  ownableColumns,
  createSharesTable,
} from "@agent-native/core/db/schema";

// A workflow is a reusable DAG of sub-agent steps (stored as JSON in `steps`).
export const workflows = table("workflows", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  steps: text("steps").notNull().default("[]"), // JSON WorkflowStep[]
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at"),
  ...ownableColumns(),
});

// A task is a unit of work the orchestrator executes against a workflow.
export const tasks = table("tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  status: text("status", {
    enum: ["pending", "running", "done", "failed", "cancelled"],
  })
    .notNull()
    .default("pending"),
  workflowId: text("workflow_id"),
  result: text("result"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at"),
  ...ownableColumns(),
});

// One execution record per workflow step per task run. The orchestrator agent
// creates these as it walks the DAG and updates status/output as sub-agents run.
export const stepRuns = table("step_runs", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  stepKey: text("step_key").notNull(),
  title: text("title").notNull(),
  assignee: text("assignee").notNull().default("local"),
  engine: text("engine"),
  model: text("model"),
  status: text("status", {
    enum: ["pending", "running", "done", "failed", "skipped"],
  })
    .notNull()
    .default("pending"),
  output: text("output"),
  error: text("error"),
  agentRunId: text("agent_run_id"),
  ordering: integer("ordering").notNull().default(0),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// Saved model runtimes the user can activate: local vLLM / OpenAI-compatible
// endpoints, or the Claude Code harness (subscription).
export const runtimeConfigs = table("runtime_configs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind", {
    enum: ["vllm", "openai-compatible", "claude-code"],
  })
    .notNull()
    .default("vllm"),
  baseUrl: text("base_url"),
  model: text("model"),
  active: integer("active").notNull().default(0),
  ownerEmail: text("owner_email").notNull().default("local@localhost"),
  orgId: text("org_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const taskShares = createSharesTable("task_shares");
export const workflowShares = createSharesTable("workflow_shares");

// ─── v2 graph engine tables (additive — the v1 tables above are untouched) ───

// A versioned, reusable workflow graph. `graph` is a JSON WorkflowGraph
// (shared/types.ts). The editor authors it; the agent patches it via
// save-template.
export const workflowTemplates = table("workflow_templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  graph: text("graph").notNull().default('{"nodes":[],"edges":[]}'),
  version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  // Soft-delete marker (mirrors v1 `workflows.deletedAt`). A soft delete keeps
  // any `workflow_runs` that referenced this template loadable for observation.
  deletedAt: text("deleted_at"),
  ...ownableColumns(),
});

// A concrete execution of a template. `work_item_id` is null for the
// template-scoped runs of P1/P2; P3 binds it to a work item.
export const workflowRuns = table("workflow_runs", {
  id: text("id").primaryKey(),
  templateId: text("template_id").notNull(),
  workItemId: text("work_item_id"),
  status: text("status", {
    enum: ["pending", "running", "paused", "done", "failed", "cancelled"],
  })
    .notNull()
    .default("pending"),
  deliverable: text("deliverable"), // JSON { kind, ref } | null
  tokenBudget: integer("token_budget"),
  tokensSpent: integer("tokens_spent").notNull().default(0),
  // Set when decomposition resolved this run's workflow via the DYNAMIC path
  // (DESIGN §6.3 order 3 — neither explicit workflowId nor project default; the
  // brain must author the DAG). Marks the run so the UI / orchestrating skill
  // know to build + promote it. 0 = a resolved template run.
  dynamicAuthored: integer("dynamic_authored").notNull().default(0),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  ...ownableColumns(),
});

// One journaled NodeRun per executed node, identified by
// (run_id, node_id, iteration, fanout_index) — the §1.7 journal key (a UNIQUE
// index enforces it). Scoped via run_id → workflow_runs (no ownableColumns),
// exactly like step_runs is scoped via task_id.
export const nodeRuns = table("node_runs", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  nodeId: text("node_id").notNull(),
  type: text("type").notNull(),
  title: text("title").notNull().default(""),
  assignee: text("assignee"),
  engine: text("engine"),
  model: text("model"),
  status: text("status", {
    enum: [
      "pending",
      "ready",
      "running",
      "done",
      "failed",
      "skipped",
      "awaiting-approval",
    ],
  })
    .notNull()
    .default("pending"),
  iteration: integer("iteration").notNull().default(0),
  fanoutIndex: integer("fanout_index").notNull().default(0),
  dynamic: integer("dynamic").notNull().default(0),
  inputRef: text("input_ref"),
  outputRef: text("output_ref"),
  error: text("error"),
  agentRunId: text("agent_run_id"),
  attempts: integer("attempts").notNull().default(0),
  tokensSpent: integer("tokens_spent").notNull().default(0),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  // Liveness for stuck-run detection (DESIGN §6.4/§13 reap). Set when a leaf
  // NodeRun starts running and refreshed on progress; the reap loop returns a
  // `running` row whose heartbeat is older than the reapThreshold to failed.
  lastHeartbeat: text("last_heartbeat"),
});

// Id-addressable artifact index over the Resources store (one index, one
// store). `node_run_id` is null for run-level artifacts.
export const artifacts = table("artifacts", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  nodeRunId: text("node_run_id"),
  kind: text("kind").notNull(),
  ref: text("ref").notNull(),
  summary: text("summary"),
  createdAt: text("created_at").notNull(),
});

export const workflowTemplateShares = createSharesTable(
  "workflow_template_shares",
);
export const workflowRunShares = createSharesTable("workflow_run_shares");

// ─── v2 project-management tables (DESIGN §6 / §9) — additive (P3a) ──────────

// A project: a named container for work items with an id prefix (`key`) and a
// `working_dir` deliverable root (always set). `git_remote`/`default_branch`
// are set only when the project links a code repo (DESIGN §6.1). `status_schemes`
// / `environments` are JSON overrides of the default schemes / env list.
export const projects = table("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  key: text("key").notNull(),
  description: text("description").notNull().default(""),
  workingDir: text("working_dir").notNull().default(""),
  gitRemote: text("git_remote"),
  defaultBranch: text("default_branch"),
  defaultWorkflowId: text("default_workflow_id"),
  // JSON SchemeSet override; null/'' → the default per-type schemes apply.
  statusSchemes: text("status_schemes"),
  // JSON string[] env list; null → DEFAULT_ENVIRONMENTS (dev/SIT/UAT/prod).
  environments: text("environments"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  ...ownableColumns(),
});

// A work item — requirement/bug/prod-issue/task. The six business-status
// dimensions (§6.2a) are written ONLY by transition-work-item; the automation
// overlay (exec_state/claimed_*) is the queue's. `status_category` is derived.
export const workItems = table("work_items", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  type: text("type", {
    enum: ["requirement", "bug", "prod-issue", "task"],
  })
    .notNull()
    .default("task"),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  priority: integer("priority").notNull().default(0),
  assignee: text("assignee"),
  // ── business status (six dimensions — sole writer: transition-work-item) ──
  status: text("status").notNull().default(""),
  statusCategory: text("status_category", {
    enum: ["todo", "in-progress", "completed", "cancelled"],
  })
    .notNull()
    .default("todo"),
  environment: text("environment"),
  severity: text("severity"),
  blocked: integer("blocked").notNull().default(0),
  blockedReason: text("blocked_reason"),
  blockedBy: text("blocked_by"),
  resolution: text("resolution"),
  statusStale: integer("status_stale").notNull().default(0),
  // ── automation overlay (§6.4) ──
  execState: text("exec_state", {
    enum: ["idle", "queued", "claimed", "running", "paused", "failed", "done"],
  })
    .notNull()
    .default("idle"),
  claimedAt: text("claimed_at"),
  claimedBy: text("claimed_by"),
  workflowId: text("workflow_id"),
  workflowRunId: text("workflow_run_id"),
  deliverable: text("deliverable"), // JSON { kind, ref } | null
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  ...ownableColumns(),
});

// A directed link between two work items (DESIGN §9). `kind` = duplicate-of |
// blocks | blocked-by | relates-to. Scoped through its work items (no own
// ownableColumns) — link CRUD asserts access on both endpoints.
export const workItemLinks = table("work_item_links", {
  id: text("id").primaryKey(),
  fromItem: text("from_item").notNull(),
  toItem: text("to_item").notNull(),
  kind: text("kind", {
    enum: ["duplicate-of", "blocks", "blocked-by", "relates-to"],
  }).notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
});

// The append-only transition trail (DESIGN §6.2b / §9). Every
// transition-work-item call writes one row; the watchdog reconciles "did status
// change during this run" against it. Scoped via work_item_id → work_items.
export const workItemStatusLog = table("work_item_status_log", {
  id: text("id").primaryKey(),
  workItemId: text("work_item_id").notNull(),
  runId: text("run_id"),
  actor: text("actor").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  blocked: integer("blocked").notNull().default(0),
  resolution: text("resolution"),
  at: text("at").notNull(),
});

// Reusable library nodes (DESIGN §3.7 / §9). `key` is referenced from a graph
// by `nodeDefKey`; `config` is the pinned node config JSON; `version` lets a
// workflow pin a known-good gate. Ownable.
export const nodeDefs = table("node_defs", {
  id: text("id").primaryKey(),
  key: text("key").notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull().default(""),
  config: text("config").notNull().default("{}"),
  version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  ...ownableColumns(),
});

export const projectShares = createSharesTable("project_shares");
export const workItemShares = createSharesTable("work_item_shares");
export const nodeDefShares = createSharesTable("node_def_shares");
