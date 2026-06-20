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
