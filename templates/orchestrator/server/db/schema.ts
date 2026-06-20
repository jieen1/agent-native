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
