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
});
