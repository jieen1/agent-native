// V3 data model (DESIGN §3) — 8 tables, all additive.
// All tables use ownableColumns() for framework scoping.
// Postgres-only: uses pg-native column types where V3 needs them (JSONB, TIMESTAMPTZ).

import {
  pgTable,
  text,
  integer,
  jsonb,
  timestamp,
  unique,
  index,
  pgEnum,
} from "drizzle-orm/pg-core";

// Reuse the framework ownableColumns pattern. The V3 tables are Postgres,
// so we define a compatible ownableColumns for pg-core.
function ownableColumns() {
  return {
    ownerEmail: text("owner_email").notNull().default("local@localhost"),
    orgId: text("org_id"),
  };
}

// ─── Enums ───────────────────────────────────────────────────────────────────

export const v3RunStatusEnum = pgEnum("v3_run_status", [
  "pending",
  "running",
  "paused",
  "done",
  "failed",
  "cancelled",
]);

export const v3NodeStatusEnum = pgEnum("v3_node_status", [
  "pending",
  "ready",
  "running",
  "done",
  "failed",
  "skipped",
  "awaiting-approval",
]);

export const v3SpawnStatusEnum = pgEnum("v3_spawn_status", [
  "pending",
  "running",
  "done",
  "failed",
  "cancelled",
]);

export const v3WorkspaceStateEnum = pgEnum("v3_workspace_state", [
  "provisioning",
  "ready",
  "busy",
  "destroying",
  "destroyed",
  "error",
]);

// ─── v3_workflow_templates ──────────────────────────────────────────────────

export const v3WorkflowTemplates = pgTable(
  "v3_workflow_templates",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    description: text("description").notNull().default(""),
    dag: jsonb("dag").notNull(),
    inputSchema: jsonb("input_schema").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    ...ownableColumns(),
  },
  (t) => [
    unique("unique_v3_wf_template_name_version").on(t.name, t.version),
  ],
);

// ─── v3_runs ────────────────────────────────────────────────────────────────

export const v3Runs = pgTable("v3_runs", {
  id: text("id").primaryKey(),
  templateId: text("template_id"),
  templateVersion: integer("template_version"),
  inputs: jsonb("inputs").notNull(),
  dag: jsonb("dag").notNull(),
  dagVersion: integer("dag_version").notNull().default(1),
  status: v3RunStatusEnum("status").notNull().default("pending"),
  priority: integer("priority").notNull().default(0),
  tags: jsonb("tags"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  ...ownableColumns(),
});

// ─── v3_nodes ───────────────────────────────────────────────────────────────

export const v3Nodes = pgTable(
  "v3_nodes",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    nodeIdInDag: text("node_id_in_dag").notNull(),
    type: text("type").notNull(),
    status: v3NodeStatusEnum("status").notNull().default("pending"),
    iteration: integer("iteration").notNull().default(0),
    fanoutIndex: integer("fanout_index").notNull().default(0),
    currentSpawnId: text("current_spawn_id"),
    outputArtifactId: text("output_artifact_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: text("error"),
    ...ownableColumns(),
  },
  (t) => [
    unique("unique_v3_node_run_id_dag_iter_fanout").on(
      t.runId,
      t.nodeIdInDag,
      t.iteration,
      t.fanoutIndex,
    ),
    index("idx_v3_nodes_run_id").on(t.runId),
  ],
);

// ─── v3_spawns ──────────────────────────────────────────────────────────────

export const v3Spawns = pgTable("v3_spawns", {
  id: text("id").primaryKey(),
  nodeId: text("node_id"),
  attempt: integer("attempt").notNull().default(1),
  agentName: text("agent_name"),
  engineRef: text("engine_ref"),
  modelRef: text("model_ref"),
  runtime: text("runtime"),
  workspaceId: text("workspace_id"),
  renderedPrompt: text("rendered_prompt").notNull(),
  logRef: text("log_ref"),
  vmName: text("vm_name"),
  acpSessionId: text("acp_session_id"),
  status: v3SpawnStatusEnum("status").notNull().default("pending"),
  outputArtifactId: text("output_artifact_id"),
  outputKind: text("output_kind"),
  tokensInput: integer("tokens_input").notNull().default(0),
  tokensOutput: integer("tokens_output").notNull().default(0),
  latencyMs: integer("latency_ms"),
  error: text("error"),
  errorClass: text("error_class"),
  tags: jsonb("tags"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  ...ownableColumns(),
},
(t) => [
  index("idx_v3_spawns_node_id").on(t.nodeId),
],
);

// ─── v3_artifacts ───────────────────────────────────────────────────────────

export const v3Artifacts = pgTable("v3_artifacts", {
  id: text("id").primaryKey(),
  spawnId: text("spawn_id").notNull(),
  kind: text("kind").notNull(),
  textContent: text("text_content"),
  objectContent: jsonb("object_content"),
  fullContentRef: text("full_content_ref"),
  byteSize: integer("byte_size"),
  truncated: integer("truncated").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  ...ownableColumns(),
},
(t) => [
  index("idx_v3_artifacts_spawn_id").on(t.spawnId),
],
);

// ─── v3_workspaces ──────────────────────────────────────────────────────────

export const v3Workspaces = pgTable(
  "v3_workspaces",
  {
    id: text("id").primaryKey(),
    ownerKind: text("owner_kind").notNull(),
    ownerId: text("owner_id").notNull(),
    tags: jsonb("tags"),
    vmName: text("vm_name"),
    repoUrl: text("repo_url"),
    branch: text("branch"),
    state: v3WorkspaceStateEnum("state").notNull().default("provisioning"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    destroyedAt: timestamp("destroyed_at", { withTimezone: true }),
    createdBy: text("created_by"),
    ...ownableColumns(),
  },
  (t) => [
    index("idx_v3_workspaces_owner").on(t.ownerKind, t.ownerId),
    unique("unique_v3_workspaces_vm_name").on(t.vmName),
  ],
);

// ─── v3_patches ─────────────────────────────────────────────────────────────

export const v3Patches = pgTable("v3_patches", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  dagVersionBefore: integer("dag_version_before").notNull(),
  dagVersionAfter: integer("dag_version_after").notNull(),
  patchOps: jsonb("patch_ops").notNull(),
  actor: text("actor").notNull(),
  reason: text("reason"),
  applied: integer("applied").notNull().default(0),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  ...ownableColumns(),
},
(t) => [
  index("idx_v3_patches_run_id").on(t.runId),
],
);

// ─── v3_events ──────────────────────────────────────────────────────────────

export const v3Events = pgTable("v3_events", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  spawnId: text("spawn_id"),
  kind: text("kind").notNull(),
  payload: jsonb("payload"),
  seqNum: integer("seq_num"),
  ts: timestamp("ts", { withTimezone: true }).defaultNow(),
  ...ownableColumns(),
},
(t) => [
  index("idx_v3_events_run_seq").on(t.runId, t.seqNum),
  index("idx_v3_events_spawn_id").on(t.spawnId),
],
);
