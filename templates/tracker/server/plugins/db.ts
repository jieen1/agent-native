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
  ],
  { table: "tracker_migrations" },
);
