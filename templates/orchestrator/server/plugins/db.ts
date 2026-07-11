import { runMigrations } from "@agent-native/core/db";

// Dialect-agnostic, additive migrations. ownableColumns() expands to
// owner_email / org_id / visibility; SQLite needs them added one ALTER at a
// time, Postgres can batch. Never drop or rename — only add.
const migrateV2 = runMigrations(
  [
    {
      version: 1,
      sql: `CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    steps TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    owner_email TEXT NOT NULL DEFAULT 'local@localhost',
    org_id TEXT,
    visibility TEXT NOT NULL DEFAULT 'private'
  )`,
    },
    {
      version: 2,
      sql: `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','failed','cancelled')),
    workflow_id TEXT,
    result TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    owner_email TEXT NOT NULL DEFAULT 'local@localhost',
    org_id TEXT,
    visibility TEXT NOT NULL DEFAULT 'private'
  )`,
    },
    {
      version: 3,
      sql: `CREATE TABLE IF NOT EXISTS step_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    step_key TEXT NOT NULL,
    title TEXT NOT NULL,
    assignee TEXT NOT NULL DEFAULT 'local',
    engine TEXT,
    model TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','failed','skipped')),
    output TEXT,
    error TEXT,
    agent_run_id TEXT,
    ordering INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
    },
    {
      version: 4,
      sql: {
        postgres: `CREATE TABLE IF NOT EXISTS task_shares (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (now())
);
CREATE TABLE IF NOT EXISTS workflow_shares (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (now())
)`,
        sqlite: `CREATE TABLE IF NOT EXISTS task_shares (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS workflow_shares (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,
      },
    },
    {
      version: 5,
      sql: `CREATE INDEX IF NOT EXISTS tasks_owner_org_updated_idx ON tasks (owner_email, org_id, updated_at);
CREATE INDEX IF NOT EXISTS workflows_owner_org_updated_idx ON workflows (owner_email, org_id, updated_at);
CREATE INDEX IF NOT EXISTS step_runs_task_idx ON step_runs (task_id, ordering);
CREATE INDEX IF NOT EXISTS task_shares_resource_idx ON task_shares (resource_id, principal_type, principal_id);
CREATE INDEX IF NOT EXISTS workflow_shares_resource_idx ON workflow_shares (resource_id, principal_type, principal_id)`,
    },
    {
      version: 6,
      sql: `CREATE TABLE IF NOT EXISTS runtime_configs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'vllm' CHECK(kind IN ('vllm','openai-compatible','claude-code')),
    base_url TEXT,
    model TEXT,
    active INTEGER NOT NULL DEFAULT 0,
    owner_email TEXT NOT NULL DEFAULT 'local@localhost',
    org_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
    },
    {
      version: 7,
      sql: `CREATE INDEX IF NOT EXISTS runtime_configs_owner_idx ON runtime_configs (owner_email, org_id, updated_at)`,
    },
    {
      // v2 graph engine tables (DESIGN §9) — additive, CREATE-only.
      version: 8,
      sql: `CREATE TABLE IF NOT EXISTS workflow_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    graph TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    owner_email TEXT NOT NULL DEFAULT 'local@localhost',
    org_id TEXT,
    visibility TEXT NOT NULL DEFAULT 'private'
  );
CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL,
    work_item_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','paused','done','failed','cancelled')),
    deliverable TEXT,
    token_budget INTEGER,
    tokens_spent INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    completed_at TEXT,
    owner_email TEXT NOT NULL DEFAULT 'local@localhost',
    org_id TEXT,
    visibility TEXT NOT NULL DEFAULT 'private'
  );
CREATE TABLE IF NOT EXISTS node_runs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    assignee TEXT,
    engine TEXT,
    model TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','running','done','failed','skipped','awaiting-approval')),
    iteration INTEGER NOT NULL DEFAULT 0,
    fanout_index INTEGER NOT NULL DEFAULT 0,
    dynamic INTEGER NOT NULL DEFAULT 0,
    input_ref TEXT,
    output_ref TEXT,
    error TEXT,
    agent_run_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    tokens_spent INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    completed_at TEXT
  );
CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    node_run_id TEXT,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    summary TEXT,
    created_at TEXT NOT NULL
  )`,
    },
    {
      // Shares tables for the two ownable v2 tables (structure only; sharing
      // UI deferred). Mirrors v4's postgres/sqlite created_at default split.
      version: 9,
      sql: {
        postgres: `CREATE TABLE IF NOT EXISTS workflow_template_shares (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (now())
);
CREATE TABLE IF NOT EXISTS workflow_run_shares (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (now())
)`,
        sqlite: `CREATE TABLE IF NOT EXISTS workflow_template_shares (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS workflow_run_shares (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,
      },
    },
    {
      // Indexes. The UNIQUE journal key (run_id,node_id,iteration,fanout_index)
      // is load-bearing for §1.7 resume — it MUST be UNIQUE.
      version: 10,
      sql: `CREATE INDEX IF NOT EXISTS node_runs_run_idx ON node_runs (run_id);
CREATE UNIQUE INDEX IF NOT EXISTS node_runs_journal_key_idx ON node_runs (run_id, node_id, iteration, fanout_index);
CREATE INDEX IF NOT EXISTS workflow_runs_work_item_idx ON workflow_runs (work_item_id);
CREATE INDEX IF NOT EXISTS artifacts_node_run_idx ON artifacts (node_run_id);
CREATE INDEX IF NOT EXISTS workflow_templates_owner_org_updated_idx ON workflow_templates (owner_email, org_id, updated_at);
CREATE INDEX IF NOT EXISTS workflow_runs_owner_org_idx ON workflow_runs (owner_email, org_id);
CREATE INDEX IF NOT EXISTS workflow_template_shares_resource_idx ON workflow_template_shares (resource_id, principal_type, principal_id);
CREATE INDEX IF NOT EXISTS workflow_run_shares_resource_idx ON workflow_run_shares (resource_id, principal_type, principal_id)`,
    },
    {
      // P1b-2: liveness column for stuck-run detection + reap (DESIGN §6.4/§13).
      // ADDITIVE — a single ALTER ADD COLUMN; never drops or rewrites the table.
      // The reap loop and the partial index below find stranded `running` rows.
      version: 11,
      sql: `ALTER TABLE node_runs ADD COLUMN last_heartbeat TEXT;
CREATE INDEX IF NOT EXISTS node_runs_running_heartbeat_idx ON node_runs (status, last_heartbeat)`,
    },
    {
      // P1b-3: soft-delete marker for workflow_templates (DESIGN §10 delete-
      // template). ADDITIVE — a single ALTER ADD COLUMN; a soft delete keeps any
      // workflow_runs that referenced the template loadable for observation.
      version: 12,
      sql: `ALTER TABLE workflow_templates ADD COLUMN deleted_at TEXT`,
    },
    {
      // P3a: project-management tables (DESIGN §6 / §9) — additive, CREATE-only.
      // The five PM tables: projects, work_items (six business-status dims +
      // automation overlay), work_item_links, work_item_status_log, node_defs.
      version: 13,
      sql: `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    working_dir TEXT NOT NULL DEFAULT '',
    git_remote TEXT,
    default_branch TEXT,
    default_workflow_id TEXT,
    status_schemes TEXT,
    environments TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    owner_email TEXT NOT NULL DEFAULT 'local@localhost',
    org_id TEXT,
    visibility TEXT NOT NULL DEFAULT 'private'
  );
CREATE TABLE IF NOT EXISTS work_items (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'task' CHECK(type IN ('requirement','bug','prod-issue','task')),
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    priority INTEGER NOT NULL DEFAULT 0,
    assignee TEXT,
    status TEXT NOT NULL DEFAULT '',
    status_category TEXT NOT NULL DEFAULT 'todo' CHECK(status_category IN ('todo','in-progress','completed','cancelled')),
    environment TEXT,
    severity TEXT,
    blocked INTEGER NOT NULL DEFAULT 0,
    blocked_reason TEXT,
    blocked_by TEXT,
    resolution TEXT,
    status_stale INTEGER NOT NULL DEFAULT 0,
    exec_state TEXT NOT NULL DEFAULT 'idle' CHECK(exec_state IN ('idle','queued','claimed','running','paused','failed','done')),
    claimed_at TEXT,
    claimed_by TEXT,
    workflow_id TEXT,
    workflow_run_id TEXT,
    deliverable TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    owner_email TEXT NOT NULL DEFAULT 'local@localhost',
    org_id TEXT,
    visibility TEXT NOT NULL DEFAULT 'private'
  );
CREATE TABLE IF NOT EXISTS work_item_links (
    id TEXT PRIMARY KEY,
    from_item TEXT NOT NULL,
    to_item TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('duplicate-of','blocks','blocked-by','relates-to')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
CREATE TABLE IF NOT EXISTS work_item_status_log (
    id TEXT PRIMARY KEY,
    work_item_id TEXT NOT NULL,
    run_id TEXT,
    actor TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    blocked INTEGER NOT NULL DEFAULT 0,
    resolution TEXT,
    at TEXT NOT NULL
  );
CREATE TABLE IF NOT EXISTS node_defs (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    config TEXT NOT NULL DEFAULT '{}',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    owner_email TEXT NOT NULL DEFAULT 'local@localhost',
    org_id TEXT,
    visibility TEXT NOT NULL DEFAULT 'private'
  )`,
    },
    {
      // P3a: shares tables for the three ownable PM tables (structure only;
      // sharing UI deferred — §9/§12). Mirrors v4/v9 postgres/sqlite split.
      version: 14,
      sql: {
        postgres: `CREATE TABLE IF NOT EXISTS project_shares (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (now())
);
CREATE TABLE IF NOT EXISTS work_item_shares (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (now())
);
CREATE TABLE IF NOT EXISTS node_def_shares (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (now())
)`,
        sqlite: `CREATE TABLE IF NOT EXISTS project_shares (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS work_item_shares (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS node_def_shares (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,
      },
    },
    {
      // P3a: indexes (DESIGN §9). The queue-claim hot path work_items(exec_state,
      // priority); project scoping; the status-log + link lookups; node_defs(key).
      version: 15,
      sql: `CREATE INDEX IF NOT EXISTS work_items_exec_priority_idx ON work_items (exec_state, priority);
CREATE INDEX IF NOT EXISTS work_items_project_idx ON work_items (project_id);
CREATE INDEX IF NOT EXISTS work_items_owner_org_updated_idx ON work_items (owner_email, org_id, updated_at);
CREATE INDEX IF NOT EXISTS work_item_status_log_item_idx ON work_item_status_log (work_item_id);
CREATE INDEX IF NOT EXISTS work_item_status_log_run_idx ON work_item_status_log (run_id);
CREATE INDEX IF NOT EXISTS work_item_links_from_idx ON work_item_links (from_item);
CREATE INDEX IF NOT EXISTS work_item_links_to_idx ON work_item_links (to_item);
CREATE INDEX IF NOT EXISTS node_defs_key_idx ON node_defs (key);
CREATE INDEX IF NOT EXISTS projects_owner_org_updated_idx ON projects (owner_email, org_id, updated_at);
CREATE INDEX IF NOT EXISTS project_shares_resource_idx ON project_shares (resource_id, principal_type, principal_id);
CREATE INDEX IF NOT EXISTS work_item_shares_resource_idx ON work_item_shares (resource_id, principal_type, principal_id);
CREATE INDEX IF NOT EXISTS node_def_shares_resource_idx ON node_def_shares (resource_id, principal_type, principal_id)`,
    },
    {
      // P3c: mark runs whose workflow was resolved via the DYNAMIC decomposition
      // path (DESIGN §6.3 order 3 — the brain authors the DAG). Additive column,
      // default 0 so every existing run reads as a resolved-template run.
      version: 16,
      sql: `ALTER TABLE workflow_runs ADD COLUMN dynamic_authored INTEGER NOT NULL DEFAULT 0`,
    },
    {
      // P5 §8.3 item4: optional JSON model-list per runtime_config (a single
      // endpoint can serve several models). Additive; null = use the single
      // `model`. The schema reads this column, so a fresh DB needs it created.
      version: 17,
      sql: `ALTER TABLE runtime_configs ADD COLUMN models TEXT`,
    },
    {
      // P6 §7.4.7: append-only AUDIT LOG. Captures the security/control-relevant
      // actions — run control (start/pause/resume/cancel/retry/override), every
      // transition-work-item, and credential resolution — with actor + action +
      // target + detail + at. CREATE-only, additive; a fresh DB needs this table
      // or writeAudit fails. Never updated or deleted from app code (append-only).
      version: 18,
      sql: `CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    detail TEXT,
    at TEXT NOT NULL,
    owner_email TEXT NOT NULL DEFAULT 'local@localhost',
    org_id TEXT
  );
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at);
CREATE INDEX IF NOT EXISTS audit_log_target_idx ON audit_log (target_type, target_id);
CREATE INDEX IF NOT EXISTS audit_log_owner_idx ON audit_log (owner_email, org_id, at)`,
    },
    {
      // Agent definitions table (DESIGN §7). Worker agent configs — name, engine,
      // model, tools, system prompt, runtime. `name` is globally unique; used as
      // the key the DAG nodes reference and the dispatcher resolves. created_at/
      // updated_at are written by the app layer as ISO strings (no DB now() needed).
      version: 19,
      sql: `CREATE TABLE IF NOT EXISTS orchestrator_agent_defs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    engine TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    tools TEXT NOT NULL DEFAULT '[]',
    system_prompt TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    runtime TEXT NOT NULL DEFAULT 'none',
    builtin INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    owner_email TEXT NOT NULL DEFAULT 'local@localhost',
    org_id TEXT,
    visibility TEXT NOT NULL DEFAULT 'private'
  );
CREATE UNIQUE INDEX IF NOT EXISTS orchestrator_agent_defs_name_idx ON orchestrator_agent_defs (name)`,
    },
    {
      // Agent definition shares table — mirrors the node_def_shares structure
      // (v14). Postgres uses now(), SQLite uses datetime('now').
      version: 20,
      sql: {
        postgres: `CREATE TABLE IF NOT EXISTS orchestrator_agent_def_shares (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (now())
);
CREATE INDEX IF NOT EXISTS orchestrator_agent_def_shares_resource_idx ON orchestrator_agent_def_shares (resource_id, principal_type, principal_id)`,
        sqlite: `CREATE TABLE IF NOT EXISTS orchestrator_agent_def_shares (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS orchestrator_agent_def_shares_resource_idx ON orchestrator_agent_def_shares (resource_id, principal_type, principal_id)`,
      },
    },
    {
      // Skills / Runbook editor hosted-mode override table (additive,
      // CREATE-only). One row per overridden skill path
      // ("skills/<name>/SKILL.md", or the "brain-runbook" sentinel for the
      // brain's own BRAIN_PROMPT); a row's presence means a hosted override
      // shadows the file/constant default. `name:` opts this migration into
      // name-based tracking per the storing-data skill's migration-collision
      // guidance (parallel branches extending this same list independently).
      version: 21,
      name: "orchestrator-skill-overrides-table",
      sql: `CREATE TABLE IF NOT EXISTS orchestrator_skill_overrides (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT
  );
CREATE UNIQUE INDEX IF NOT EXISTS orchestrator_skill_overrides_path_idx ON orchestrator_skill_overrides (path)`,
    },
  ],
  { table: "orchestrator_migrations" },
);

// ─────────────────────────────────────────────────────────────────────────────
// V3 (DESIGN §3) — folded in from the deleted `server/db/v3-migrations/
// 0001_init.sql` (the drizzle-kit output for v3-schema.ts) plus the P4-A
// additive columns (formerly `server/db/v3-schema-p4.ts`) and
// `brain_tasks.reap_reason` (formerly `server/db/brain-schema.ts`).
//
// V3 previously ran its DDL through its own ad hoc `ensureV3Schema()` /
// `ensureBrainSchema()` bootstrappers against a SEPARATE Postgres pool
// (server/db/v3.ts, now deleted). That pool pointed at the SAME physical
// database `getDb()` already uses on every deployed environment, so this is a
// pure access-layer fold: every statement below is a no-op against an
// existing DB and creates everything on a fresh one.
//
// Postgres-only (`sql: { postgres: ... }`, no `sqlite` key) — V3 has never
// run on SQLite; on that dialect `resolveMigrationSql` returns null and the
// entry is recorded as applied without running anything.
//
// `IF NOT EXISTS` was added by hand to every CREATE TABLE / CREATE INDEX
// statement below. `CREATE TYPE` has NO such clause in Postgres, so re-running
// it on a second boot throws 42710 "already exists" — packages/core's
// `runMigrations` now swallows that specific race (`isPgCatalogRace`, see
// packages/core/src/db/migrations.ts) instead of crash-looping the server. A
// `DO $$ ... $$` guard was deliberately NOT used instead: migrations.ts's
// `splitSqlStatements()` has no `$$`-awareness and would shred a dollar-quoted
// block on its own `;`-splitting.
const migrateV3 = runMigrations(
  [
    {
      // Version-only tracking (no `name:`) — matches every other migration table
      // in this repo. A `name:` here would make runMigrations gate on the
      // companion `v3_migrations_names` table instead of `v3_migrations`; the
      // CREATE TYPE 42710-swallow on the first folded boot (existing DB) leaves
      // that named-row insert unpersisted, so the named gate never sees it and
      // re-applies all 32 statements every boot. The version gate (v3_migrations)
      // records cleanly, so version-only is tracked-once on both fresh and
      // existing databases.
      version: 1,
      sql: {
        postgres: `CREATE TYPE "public"."v3_node_status" AS ENUM('pending', 'ready', 'running', 'done', 'failed', 'skipped', 'awaiting-approval');
CREATE TYPE "public"."v3_run_status" AS ENUM('pending', 'running', 'paused', 'done', 'failed', 'cancelled');
CREATE TYPE "public"."v3_spawn_status" AS ENUM('pending', 'running', 'done', 'failed', 'cancelled');
CREATE TYPE "public"."v3_workspace_state" AS ENUM('provisioning', 'ready', 'busy', 'destroying', 'destroyed', 'error');
CREATE TABLE IF NOT EXISTS "brain_events" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"text" text,
	"tool_name" text,
	"tool_use_id" text,
	"tool_input" jsonb,
	"tool_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"owner_email" text DEFAULT 'local@localhost' NOT NULL,
	"org_id" text,
	CONSTRAINT "unique_brain_event_thread_seq" UNIQUE("thread_id","seq")
);
CREATE TABLE IF NOT EXISTS "brain_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"message" text,
	"repo" text,
	"base_branch" text,
	"workspace_id" text,
	"tags" jsonb,
	"priority" integer DEFAULT 0 NOT NULL,
	"run_id" text,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"owner_email" text DEFAULT 'local@localhost' NOT NULL,
	"org_id" text
);
CREATE TABLE IF NOT EXISTS "brain_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text DEFAULT 'New session' NOT NULL,
	"session_id" text,
	"status" text DEFAULT 'idle' NOT NULL,
	"workspace_id" text,
	"cwd" text,
	"error" text,
	"monitor_interval_sec" integer,
	"last_wake_at" timestamp with time zone,
	"model" text,
	"context_window" integer,
	"context_used" integer,
	"last_usage" jsonb,
	"archived" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"owner_email" text DEFAULT 'local@localhost' NOT NULL,
	"org_id" text
);
CREATE TABLE IF NOT EXISTS "spawn_events" (
	"id" text PRIMARY KEY NOT NULL,
	"spawn_id" text NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"name" text,
	"input" jsonb,
	"result" jsonb,
	"text" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"owner_email" text DEFAULT 'local@localhost' NOT NULL,
	"org_id" text,
	CONSTRAINT "unique_spawn_event_spawn_seq" UNIQUE("spawn_id","seq")
);
CREATE TABLE IF NOT EXISTS "v3_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"spawn_id" text NOT NULL,
	"kind" text NOT NULL,
	"text_content" text,
	"object_content" jsonb,
	"full_content_ref" text,
	"byte_size" integer,
	"truncated" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"owner_email" text DEFAULT 'local@localhost' NOT NULL,
	"org_id" text
);
CREATE TABLE IF NOT EXISTS "v3_events" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text,
	"spawn_id" text,
	"kind" text NOT NULL,
	"payload" jsonb,
	"seq_num" integer,
	"ts" timestamp with time zone DEFAULT now(),
	"owner_email" text DEFAULT 'local@localhost' NOT NULL,
	"org_id" text
);
CREATE TABLE IF NOT EXISTS "v3_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"node_id_in_dag" text NOT NULL,
	"type" text NOT NULL,
	"status" "v3_node_status" DEFAULT 'pending' NOT NULL,
	"iteration" integer DEFAULT 0 NOT NULL,
	"fanout_index" integer DEFAULT 0 NOT NULL,
	"current_spawn_id" text,
	"output_artifact_id" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error" text,
	"owner_email" text DEFAULT 'local@localhost' NOT NULL,
	"org_id" text,
	CONSTRAINT "unique_v3_node_run_id_dag_iter_fanout" UNIQUE("run_id","node_id_in_dag","iteration","fanout_index")
);
CREATE TABLE IF NOT EXISTS "v3_patches" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"dag_version_before" integer NOT NULL,
	"dag_version_after" integer NOT NULL,
	"patch_ops" jsonb NOT NULL,
	"actor" text NOT NULL,
	"reason" text,
	"applied" integer DEFAULT 0 NOT NULL,
	"applied_at" timestamp with time zone,
	"owner_email" text DEFAULT 'local@localhost' NOT NULL,
	"org_id" text
);
CREATE TABLE IF NOT EXISTS "v3_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text,
	"template_version" integer,
	"inputs" jsonb NOT NULL,
	"dag" jsonb NOT NULL,
	"dag_version" integer DEFAULT 1 NOT NULL,
	"status" "v3_run_status" DEFAULT 'pending' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"tags" jsonb,
	"archived" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"owner_email" text DEFAULT 'local@localhost' NOT NULL,
	"org_id" text
);
CREATE TABLE IF NOT EXISTS "v3_spawns" (
	"id" text PRIMARY KEY NOT NULL,
	"node_id" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"agent_name" text,
	"engine_ref" text,
	"model_ref" text,
	"runtime" text,
	"workspace_id" text,
	"rendered_prompt" text NOT NULL,
	"log_ref" text,
	"vm_name" text,
	"acp_session_id" text,
	"status" "v3_spawn_status" DEFAULT 'pending' NOT NULL,
	"output_artifact_id" text,
	"output_kind" text,
	"tokens_input" integer DEFAULT 0 NOT NULL,
	"tokens_output" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"error" text,
	"error_class" text,
	"tags" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"owner_email" text DEFAULT 'local@localhost' NOT NULL,
	"org_id" text
);
CREATE TABLE IF NOT EXISTS "v3_workflow_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"dag" jsonb NOT NULL,
	"input_schema" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"owner_email" text DEFAULT 'local@localhost' NOT NULL,
	"org_id" text,
	CONSTRAINT "unique_v3_wf_template_name_version" UNIQUE("name","version")
);
CREATE TABLE IF NOT EXISTS "v3_workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_id" text NOT NULL,
	"tags" jsonb,
	"vm_name" text,
	"host_path" text,
	"repo_url" text,
	"branch" text,
	"state" "v3_workspace_state" DEFAULT 'provisioning' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"destroyed_at" timestamp with time zone,
	"created_by" text,
	"owner_email" text DEFAULT 'local@localhost' NOT NULL,
	"org_id" text,
	CONSTRAINT "unique_v3_workspaces_vm_name" UNIQUE("vm_name")
);
CREATE INDEX IF NOT EXISTS "idx_brain_events_thread" ON "brain_events" USING btree ("thread_id");
CREATE INDEX IF NOT EXISTS "idx_brain_tasks_status" ON "brain_tasks" USING btree ("status");
CREATE INDEX IF NOT EXISTS "idx_brain_tasks_thread" ON "brain_tasks" USING btree ("thread_id");
CREATE INDEX IF NOT EXISTS "idx_brain_tasks_owner" ON "brain_tasks" USING btree ("owner_email");
CREATE INDEX IF NOT EXISTS "idx_brain_tasks_priority" ON "brain_tasks" USING btree ("priority","created_at");
CREATE INDEX IF NOT EXISTS "idx_brain_threads_owner" ON "brain_threads" USING btree ("owner_email");
CREATE INDEX IF NOT EXISTS "idx_brain_threads_updated" ON "brain_threads" USING btree ("updated_at");
CREATE INDEX IF NOT EXISTS "idx_brain_threads_archived" ON "brain_threads" USING btree ("archived");
CREATE INDEX IF NOT EXISTS "idx_spawn_events_spawn" ON "spawn_events" USING btree ("spawn_id");
CREATE INDEX IF NOT EXISTS "idx_v3_artifacts_spawn_id" ON "v3_artifacts" USING btree ("spawn_id");
CREATE INDEX IF NOT EXISTS "idx_v3_events_run_seq" ON "v3_events" USING btree ("run_id","seq_num");
CREATE INDEX IF NOT EXISTS "idx_v3_events_spawn_id" ON "v3_events" USING btree ("spawn_id");
CREATE INDEX IF NOT EXISTS "idx_v3_nodes_run_id" ON "v3_nodes" USING btree ("run_id");
CREATE INDEX IF NOT EXISTS "idx_v3_patches_run_id" ON "v3_patches" USING btree ("run_id");
CREATE INDEX IF NOT EXISTS "idx_v3_spawns_node_id" ON "v3_spawns" USING btree ("node_id");
CREATE INDEX IF NOT EXISTS "idx_v3_workspaces_owner" ON "v3_workspaces" USING btree ("owner_kind","owner_id")`,
      },
    },
    {
      // P4-A data lifecycle + reaper additive columns (formerly
      // v3-schema-p4.ts's ensureP4Columns + brain-schema.ts's reap_reason
      // ALTER). Postgres supports `ADD COLUMN IF NOT EXISTS` natively (unlike
      // `CREATE TYPE`), so no catalog-race handling is needed for these.
      version: 2,
      sql: {
        postgres: `ALTER TABLE v3_artifacts ADD COLUMN IF NOT EXISTS expires_at timestamp with time zone;
ALTER TABLE v3_artifacts ADD COLUMN IF NOT EXISTS keep_after_run integer NOT NULL DEFAULT 0;
ALTER TABLE brain_tasks ADD COLUMN IF NOT EXISTS reap_reason text`,
      },
    },
    {
      // f7-telemetry (04 §7/§10/§13 — model-identity + usage-telemetry single
      // source of truth). This module's `runMigrations` (packages/core/src/db/
      // migrations.ts, imported above) tracks ONLY `version` in this app's
      // `v3_migrations` table — there is no `name:` field on `MigrationEntry`
      // and no companion named-registry table in this core build (verified:
      // `MigrationEntry` = `{ version, sql }`, `runMigrations` only ever does
      // `SELECT MAX(version)` against the ONE table passed via `{ table }`).
      // An earlier planning pass assumed a `{ version: 4, name:
      // "f7-telemetry" }` slot after F2's `{ version: 3, name:
      // "f2-spawn-context" }` — but as of this migration's authoring, F2's
      // entry has not been added to this array (max version here is still 2),
      // so this is version 3, plain version-only tracking like every other
      // entry in this array. Kept the `f7-telemetry` name in this COMMENT
      // (not a `name:` field, which doesn't exist) purely so a future reader
      // grepping for it still finds this block.
      version: 3,
      sql: {
        postgres: `CREATE TABLE IF NOT EXISTS v3_model_registry (
  id text PRIMARY KEY,
  real_name text NOT NULL,
  alias text NOT NULL,
  tier text,
  endpoint text,
  is_claude_weight integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  owner_email text NOT NULL DEFAULT 'local@localhost',
  org_id text,
  CONSTRAINT unique_v3_model_registry_alias UNIQUE (alias)
);
ALTER TABLE v3_spawns ADD COLUMN IF NOT EXISTS model_real_name text;
ALTER TABLE v3_spawns ADD COLUMN IF NOT EXISTS usage_suspect integer NOT NULL DEFAULT 0;
ALTER TABLE brain_threads ADD COLUMN IF NOT EXISTS closing_anomaly text`,
      },
    },
  ],
  { table: "v3_migrations" },
);

export default async function orchestratorDbPlugin(
  nitroApp: unknown,
): Promise<void> {
  await migrateV2(nitroApp);
  await migrateV3(nitroApp);
}
