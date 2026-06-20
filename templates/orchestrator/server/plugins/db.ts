import { runMigrations } from "@agent-native/core/db";

// Dialect-agnostic, additive migrations. ownableColumns() expands to
// owner_email / org_id / visibility; SQLite needs them added one ALTER at a
// time, Postgres can batch. Never drop or rename — only add.
export default runMigrations(
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
  ],
  { table: "orchestrator_migrations" },
);
