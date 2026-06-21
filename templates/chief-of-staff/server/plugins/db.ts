// guard:allow-unscoped -- schema migrations run system-wide at startup, not in a user-scoped request path.
import { runMigrations } from "@agent-native/core/db";

export default runMigrations(
  [
    {
      version: 1,
      sql: `CREATE TABLE IF NOT EXISTS briefings (
  id TEXT PRIMARY KEY,
  briefing_date TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'adhoc',
  title TEXT NOT NULL,
  summary_md TEXT NOT NULL DEFAULT '',
  sources_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'compiling',
  focus TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  owner_email TEXT NOT NULL DEFAULT 'local@localhost',
  org_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private'
)`,
    },
    {
      // The shares table default-timestamp function differs per dialect, so
      // split the two like plan's plan_shares migration.
      version: 2,
      sql: {
        postgres: `CREATE TABLE IF NOT EXISTS briefing_shares (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (now())
)`,
        sqlite: `CREATE TABLE IF NOT EXISTS briefing_shares (
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
      // Composite index on the list hot path (owner + date), per the
      // performance skill — list-briefings filters by owner and orders by date.
      version: 3,
      sql: `CREATE INDEX IF NOT EXISTS briefings_owner_date_idx ON briefings(owner_email, briefing_date)`,
    },
    {
      version: 4,
      sql: `CREATE INDEX IF NOT EXISTS briefing_shares_resource_principal_idx ON briefing_shares(resource_id, principal_type, principal_id)`,
    },
  ],
  { table: "chief_of_staff_migrations" },
);
