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
  boolean,
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
  // F1 workspace contract (02-workflows.md §7): a workspace that finished
  // provisioning (clone/worktree-add succeeded) but failed the W1/W2/W3
  // readiness assertion sequence — distinct from `error` (a provisioning
  // failure). Never counted as an agent failure (errorClass=infra). Additive
  // Postgres enum value — see the `f1-workspace-contract` migration.
  "failed",
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
  (t) => [unique("unique_v3_wf_template_name_version").on(t.name, t.version)],
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
  // Additive: archive flag (0/1) — hides a run from the default list (P4-A).
  archived: integer("archived").notNull().default(0),
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

export const v3Spawns = pgTable(
  "v3_spawns",
  {
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
  (t) => [index("idx_v3_spawns_node_id").on(t.nodeId)],
);

// ─── spawn_events ────────────────────────────────────────────────────────────
// Append-only INTERMEDIATE transcript of a single spawn: the ordered reasoning
// text + every tool call (name + input) + every tool result the worker brain
// produced while running the node. Mirrors `brain_events` so the run-detail
// Node Inspector renders the same reasoning + collapsible tool-call cards.
// `seq` is monotonic within a spawn so the timeline renders in order. Additive;
// captured best-effort (a logging failure never fails the node).

export const spawnEvents = pgTable(
  "spawn_events",
  {
    id: text("id").primaryKey(),
    spawnId: text("spawn_id").notNull(),
    // Monotonic order within the spawn (0-based).
    seq: integer("seq").notNull(),
    // text | tool_use | tool_result
    type: text("type").notNull(),
    // Tool name for tool_use / tool_result steps.
    name: text("name"),
    // Tool input (tool_use) and result (tool_result) as JSONB.
    input: jsonb("input"),
    result: jsonb("result"),
    // Assistant reasoning/answer text for `text` steps.
    text: text("text"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    ...ownableColumns(),
  },
  (t) => [
    unique("unique_spawn_event_spawn_seq").on(t.spawnId, t.seq),
    index("idx_spawn_events_spawn").on(t.spawnId),
  ],
);

// ─── v3_artifacts ───────────────────────────────────────────────────────────

export const v3Artifacts = pgTable(
  "v3_artifacts",
  {
    id: text("id").primaryKey(),
    spawnId: text("spawn_id").notNull(),
    kind: text("kind").notNull(),
    textContent: text("text_content"),
    objectContent: jsonb("object_content"),
    fullContentRef: text("full_content_ref"),
    byteSize: integer("byte_size"),
    truncated: integer("truncated").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    // P4-A data lifecycle (additive): expiresAt is the TTL boundary set once
    // the artifact's run completes; keepAfterRun opts a specific artifact out
    // of TTL cleanup. Both nullable/defaulted — never dropped or renamed.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    keepAfterRun: integer("keep_after_run").notNull().default(0),
    ...ownableColumns(),
  },
  (t) => [index("idx_v3_artifacts_spawn_id").on(t.spawnId)],
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
    // Additive (host-native workspaces, DESIGN §10.6): the local checkout dir on
    // the workspace volume that agent workers cwd into. NULL for microVM
    // workspaces. Never dropped/renamed.
    hostPath: text("host_path"),
    repoUrl: text("repo_url"),
    branch: text("branch"),
    state: v3WorkspaceStateEnum("state").notNull().default("provisioning"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    destroyedAt: timestamp("destroyed_at", { withTimezone: true }),
    createdBy: text("created_by"),
    // F1 workspace contract (02-workflows.md §7, `f1-workspace-contract`
    // migration) — additive readiness bookkeeping. `baseSha`: the target
    // branch's tip at the moment W1 last confirmed merge-base distance 0.
    // `readyAt`: set only after the FULL W1→W2→W3 sequence passes — null
    // means "not ready", which the dispatcher's readiness gate checks
    // directly (never spawn/dispatch on a workspace with readyAt IS NULL).
    // `readyReport`: per-stage assertion output summaries (EvidenceCard).
    baseSha: text("base_sha"),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    readyReport: jsonb("ready_report"),
    ...ownableColumns(),
  },
  (t) => [
    index("idx_v3_workspaces_owner").on(t.ownerKind, t.ownerId),
    unique("unique_v3_workspaces_vm_name").on(t.vmName),
  ],
);

// ─── v3_patches ─────────────────────────────────────────────────────────────

export const v3Patches = pgTable(
  "v3_patches",
  {
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
  (t) => [index("idx_v3_patches_run_id").on(t.runId)],
);

// ─── v3_events ──────────────────────────────────────────────────────────────

export const v3Events = pgTable(
  "v3_events",
  {
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

// ─── brain_threads ───────────────────────────────────────────────────────────
// The orchestrator brain: a persistent, resumable Claude Code session per
// thread. session_id is the CC session captured from the stream-json init
// event; passing it on the next turn (--resume) retains full context. Additive.

export const brainThreads = pgTable(
  "brain_threads",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull().default("New session"),
    // The Claude Code session id captured from the stream-json `system/init`
    // event. Null until the first turn produces it; reused via --resume.
    sessionId: text("session_id"),
    // running | done | error | idle
    status: text("status").notNull().default("idle"),
    // Optional task workspace this thread operates in (a v3_workspaces id).
    workspaceId: text("workspace_id"),
    // The working directory the CC child runs in (resolved per turn).
    cwd: text("cwd"),
    // Last error string, when status = error.
    error: text("error"),
    // Periodic drift-check cadence in seconds for the brain monitor scheduler.
    // NULL → use the env default (BRAIN_MONITOR_INTERVAL_SEC, default 120).
    // 0 → disable the timer entirely (event-only wakes). Additive, nullable.
    monitorIntervalSec: integer("monitor_interval_sec"),
    // The last time ANY wake (event / timer / terminal) re-invoked this thread.
    // The scheduler uses this so events naturally reset the periodic timer and
    // a thread is never double-fired. Additive, nullable.
    lastWakeAt: timestamp("last_wake_at", { withTimezone: true }),
    // Live model + context telemetry captured from the stream-json child.
    // model = the resolved model id from the init `system` event (e.g.
    // claude-opus-4-8[1m]); contextWindow = result.modelUsage[model].contextWindow
    // (read from the result event, never hardcoded); contextUsed = the latest
    // assistant usage (input + cache_read + cache_creation input tokens);
    // lastUsage = the raw usage object surfaced on the brain-usage panel.
    // All additive + nullable.
    model: text("model"),
    contextWindow: integer("context_window"),
    contextUsed: integer("context_used"),
    lastUsage: jsonb("last_usage"),
    // Session-management archive flag: archived threads are hidden from the brain
    // page's default session list (the "Archived" filter reveals them).
    // archivedAt records when it was archived. Both additive.
    archived: boolean("archived").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    ...ownableColumns(),
  },
  (t) => [
    index("idx_brain_threads_owner").on(t.ownerEmail),
    index("idx_brain_threads_updated").on(t.updatedAt),
    index("idx_brain_threads_archived").on(t.archived),
  ],
);

// ─── brain_events ────────────────────────────────────────────────────────────
// Append-only transcript of a brain turn: user messages, assistant text,
// every MCP/tool call (name + input + result), and the terminal result/error.
// `seq` is monotonic within a thread so the page renders in order. Additive.

export const brainEvents = pgTable(
  "brain_events",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id").notNull(),
    // Monotonic order within the thread.
    seq: integer("seq").notNull(),
    // user | assistant | tool_use | tool_result | result | error | system
    type: text("type").notNull(),
    // Free text for user/assistant/result/error/system events.
    text: text("text"),
    // For tool_use / tool_result events.
    toolName: text("tool_name"),
    toolUseId: text("tool_use_id"),
    toolInput: jsonb("tool_input"),
    toolResult: jsonb("tool_result"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    ...ownableColumns(),
  },
  (t) => [
    unique("unique_brain_event_thread_seq").on(t.threadId, t.seq),
    index("idx_brain_events_thread").on(t.threadId),
  ],
);

// ─── brain_tasks ───────────────────────────────────────────────────────────────
// LEVEL-1 brain-task concurrency queue. One row per brain dispatch (brain-send).
// status: queued → running → done | failed | cancelled. The admission gate
// promotes up to `brain-concurrency` rows from queued→running under an atomic
// claim, and ONLY those start a `claude -p` brain child; the rest stay queued.
// A running task occupies one slot from admission until its bound run reaches
// terminal (released by the reconciler run-terminal wake) or the reaper. Additive.

export const brainTasks = pgTable(
  "brain_tasks",
  {
    id: text("id").primaryKey(),
    // The brain thread this task drives (also the run-tag beacon brainThreadId).
    threadId: text("thread_id").notNull(),
    // queued | running | done | failed | cancelled
    status: text("status").notNull().default("queued"),
    // The brain message + dispatch params, so the gate can start the turn later
    // (a queued task is not started until a slot frees).
    message: text("message"),
    repo: text("repo"),
    baseBranch: text("base_branch"),
    workspaceId: text("workspace_id"),
    tags: jsonb("tags"),
    priority: integer("priority").notNull().default(0),
    // The v3_runs id this task is bound to (set when the brain creates a run);
    // currently informational — slot release keys on the brain thread / run-tag.
    runId: text("run_id"),
    // Heartbeat: set at admission (running), used by the reaper liveness cutoff.
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    // The reaper's release reason (e.g. "reaped: thread already done"), so a
    // timeout-driven release is distinguishable from a real brain failure.
    // Nullable/additive — NULL means the task reached terminal through the
    // normal run-terminal release, not the reaper.
    reapReason: text("reap_reason"),
    ...ownableColumns(),
  },
  (t) => [
    index("idx_brain_tasks_status").on(t.status),
    index("idx_brain_tasks_thread").on(t.threadId),
    index("idx_brain_tasks_owner").on(t.ownerEmail),
    index("idx_brain_tasks_priority").on(t.priority, t.createdAt),
  ],
);
