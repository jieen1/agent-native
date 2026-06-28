import { runMigrations } from "@agent-native/core/db";

// Tracker schema migrations. Idempotent CREATE TABLE / INDEX IF NOT EXISTS,
// dialect-agnostic strings (work on both Postgres in deployment and LibSQL in
// local dev). Ownable columns (owner_email/org_id/visibility) are declared
// inline so accessFilter()/resolveAccess() work out of the box. Additive only.
//
// NOTE: tables are namespaced `tracker_*`. The tracker shares one Postgres with
// the orchestrator, which already owns generic `projects` / `work_items` tables;
// an un-namespaced CREATE TABLE IF NOT EXISTS would silently bind to the
// orchestrator's tables (wrong columns). v1-v3 created un-namespaced tables and
// are retained as no-op history; v4+ create the namespaced tables the app uses.
export default runMigrations(
  [
    { version: 1, sql: `SELECT 1` },
    { version: 2, sql: `SELECT 1` },
    { version: 3, sql: `SELECT 1` },
    {
      version: 4,
      sql: `CREATE TABLE IF NOT EXISTS tracker_projects (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  git_remote TEXT NOT NULL DEFAULT '',
  default_branch TEXT NOT NULL DEFAULT 'main',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  owner_email TEXT NOT NULL DEFAULT 'local@localhost',
  org_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private'
)`,
    },
    {
      version: 5,
      sql: `CREATE TABLE IF NOT EXISTS tracker_work_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'requirement',
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  priority INTEGER NOT NULL DEFAULT 0,
  orchestrator_thread_id TEXT,
  orchestrator_workspace_id TEXT,
  dispatched_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  owner_email TEXT NOT NULL DEFAULT 'local@localhost',
  org_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private'
)`,
    },
    {
      // Hot-path indexes: board lists projects by updated_at and work items by
      // project_id + updated_at, both scoped by owner_email/org_id.
      version: 6,
      sql: `CREATE INDEX IF NOT EXISTS tracker_projects_owner_org_updated_idx ON tracker_projects (owner_email, org_id, updated_at);
CREATE INDEX IF NOT EXISTS tracker_work_items_project_updated_idx ON tracker_work_items (project_id, updated_at);
CREATE INDEX IF NOT EXISTS tracker_work_items_owner_org_idx ON tracker_work_items (owner_email, org_id)`,
    },
    {
      // Additive: carry the orchestrator brain_task id (the admission-gate row)
      // and the bound DAG run id so the board can reflect the live slot gate
      // (queued → running → done) and confirm a real run reached terminal.
      version: 7,
      sql: `ALTER TABLE tracker_work_items ADD COLUMN IF NOT EXISTS orchestrator_task_id TEXT;
ALTER TABLE tracker_work_items ADD COLUMN IF NOT EXISTS orchestrator_run_id TEXT`,
    },
    {
      // Additive columns on work_items: sprint binding, item keying, risk, tags,
      // execution mode, stage tracking, and branch.
      version: 8,
      sql: `ALTER TABLE tracker_work_items ADD COLUMN IF NOT EXISTS sprint_id TEXT;
ALTER TABLE tracker_work_items ADD COLUMN IF NOT EXISTS item_key TEXT NOT NULL DEFAULT '';
ALTER TABLE tracker_work_items ADD COLUMN IF NOT EXISTS risk TEXT NOT NULL DEFAULT 'medium';
ALTER TABLE tracker_work_items ADD COLUMN IF NOT EXISTS tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tracker_work_items ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE tracker_work_items ADD COLUMN IF NOT EXISTS planned_stages TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tracker_work_items ADD COLUMN IF NOT EXISTS current_stage_name TEXT NOT NULL DEFAULT '待办';
ALTER TABLE tracker_work_items ADD COLUMN IF NOT EXISTS branch TEXT`,
    },
    {
      // New tracker tables: sprints, stages, artifacts, activities, comments, links,
      // rollback_log, exec_queue.
      version: 9,
      sql: `CREATE TABLE IF NOT EXISTS tracker_sprints (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned',
  start_date TEXT,
  end_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  owner_email TEXT NOT NULL DEFAULT 'local@localhost',
  org_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private'
);
CREATE TABLE IF NOT EXISTS tracker_stages (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  stage_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '待执行',
  started_at TEXT,
  completed_at TEXT,
  verdict TEXT,
  delivery_items TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  owner_email TEXT NOT NULL DEFAULT 'local@localhost',
  org_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private'
);
CREATE TABLE IF NOT EXISTS tracker_artifacts (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  stage_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  content_ref TEXT NOT NULL DEFAULT '',
  produced_by_kind TEXT NOT NULL DEFAULT 'agent',
  supersedes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  owner_email TEXT NOT NULL DEFAULT 'local@localhost',
  org_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private'
);
CREATE TABLE IF NOT EXISTS tracker_activities (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL DEFAULT 'agent',
  actor_name TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  owner_email TEXT NOT NULL DEFAULT 'local@localhost',
  org_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private'
);
CREATE TABLE IF NOT EXISTS tracker_comments (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  author_kind TEXT NOT NULL DEFAULT 'human',
  author_name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  owner_email TEXT NOT NULL DEFAULT 'local@localhost',
  org_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private'
);
CREATE TABLE IF NOT EXISTS tracker_links (
  id TEXT PRIMARY KEY,
  from_item_id TEXT NOT NULL,
  to_item_id TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT 'relates_to',
  created_at TEXT NOT NULL,
  owner_email TEXT NOT NULL DEFAULT 'local@localhost',
  org_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private'
);
CREATE TABLE IF NOT EXISTS tracker_rollback_log (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  from_stage TEXT NOT NULL,
  to_stage TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  rolled_back_at TEXT NOT NULL,
  owner_email TEXT NOT NULL DEFAULT 'local@localhost',
  org_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private'
);
CREATE TABLE IF NOT EXISTS tracker_exec_queue (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  position INTEGER NOT NULL DEFAULT 0,
  enqueued_at TEXT NOT NULL,
  dequeued_at TEXT,
  owner_email TEXT NOT NULL DEFAULT 'local@localhost',
  org_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private'
)`,
    },
    {
      // Indexes on new tables for owner-scoped list queries.
      version: 10,
      sql: `CREATE INDEX IF NOT EXISTS tracker_sprints_owner_org_idx ON tracker_sprints (owner_email, org_id);
CREATE INDEX IF NOT EXISTS tracker_stages_work_item_idx ON tracker_stages (work_item_id);
CREATE INDEX IF NOT EXISTS tracker_artifacts_work_item_idx ON tracker_artifacts (work_item_id);
CREATE INDEX IF NOT EXISTS tracker_activities_work_item_idx ON tracker_activities (work_item_id, created_at);
CREATE INDEX IF NOT EXISTS tracker_comments_work_item_idx ON tracker_comments (work_item_id, created_at);
CREATE INDEX IF NOT EXISTS tracker_links_from_item_idx ON tracker_links (from_item_id);
CREATE INDEX IF NOT EXISTS tracker_exec_queue_owner_status_idx ON tracker_exec_queue (owner_email, status, position)`,
    },
    {
      // Fix column name mismatches between migration v9 SQL and schema.ts.
      // v9 used wrong names; add the correct columns the Drizzle schema expects.
      // Old columns are kept (additive only) but won't be queried by Drizzle.
      version: 11,
      sql: `ALTER TABLE tracker_sprints ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT '';
ALTER TABLE tracker_sprints ADD COLUMN IF NOT EXISTS branch TEXT NOT NULL DEFAULT '';
ALTER TABLE tracker_stages ADD COLUMN IF NOT EXISTS stage_status TEXT NOT NULL DEFAULT '待执行';
ALTER TABLE tracker_stages ADD COLUMN IF NOT EXISTS workflow_run_ref TEXT;
ALTER TABLE tracker_links ADD COLUMN IF NOT EXISTS link_type TEXT NOT NULL DEFAULT 'relates_to';
ALTER TABLE tracker_rollback_log ADD COLUMN IF NOT EXISTS by_kind TEXT NOT NULL DEFAULT 'agent';
ALTER TABLE tracker_exec_queue ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tracker_exec_queue ADD COLUMN IF NOT EXISTS current_stage TEXT NOT NULL DEFAULT '';
ALTER TABLE tracker_exec_queue ADD COLUMN IF NOT EXISTS started_at TEXT`,
    },
  ],
  { table: "tracker_migrations" },
);
