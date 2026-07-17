import crypto from "node:crypto";

import { getDbExec, runMigrations } from "@agent-native/core/db";

/** Derive the array-element type straight from `runMigrations`'s own params
 *  so this file never re-declares (and risks drifting from) core's
 *  `MigrationEntry`/`MigrationSql` shape — core doesn't re-export those types
 *  from its `./db` subpath (only the `runMigrations` value). */
type MigrationEntry = Parameters<typeof runMigrations>[0][number];

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
//
// Exported (not just used inline) as of F6 so:
//  - `server/lib/migration-audit.ts` can read the real migration SQL text at
//    runtime via introspection (no fs read, no build snapshot — see that
//    module's docblock).
//  - The hash-collision guard below (`verifyMigrationHashes`) can compute each
//    version's expected content hash from the SAME array core's `runMigrations`
//    applies, so the two never drift apart.
export const TRACKER_MIGRATIONS: MigrationEntry[] = [
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
  {
    // v2 design: owner (负责人) and nature (性质) columns on work_items.
    version: 12,
    sql: `ALTER TABLE tracker_work_items ADD COLUMN IF NOT EXISTS owner TEXT;
ALTER TABLE tracker_work_items ADD COLUMN IF NOT EXISTS nature TEXT NOT NULL DEFAULT '[]'`,
  },
  {
    // M1-1: multi-repo registry per project.
    version: 13,
    sql: `CREATE TABLE IF NOT EXISTS tracker_project_repos (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  git_remote TEXT NOT NULL DEFAULT '',
  base_branch TEXT NOT NULL DEFAULT 'main',
  test_cmd_unit TEXT NOT NULL DEFAULT '',
  test_cmd_full TEXT NOT NULL DEFAULT '',
  e2e_test_path TEXT NOT NULL DEFAULT '',
  integration_test_path TEXT NOT NULL DEFAULT '',
  build_tool TEXT NOT NULL DEFAULT '',
  ci_mode TEXT NOT NULL DEFAULT 'none',
  gate_mode TEXT NOT NULL DEFAULT 'tests-only',
  dev_model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  owner_email TEXT NOT NULL DEFAULT 'local@localhost',
  org_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private'
);
CREATE UNIQUE INDEX IF NOT EXISTS tracker_project_repos_project_name_idx ON tracker_project_repos (owner_email, project_id, name);
CREATE INDEX IF NOT EXISTS tracker_project_repos_project_idx ON tracker_project_repos (project_id)`,
  },
  {
    // M1-2: sprint-level versioned artifact library.
    version: 14,
    sql: `CREATE TABLE IF NOT EXISTS tracker_sprint_artifacts (
  id TEXT PRIMARY KEY,
  sprint_id TEXT NOT NULL,
  doc_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  supersedes TEXT,
  produced_by_kind TEXT NOT NULL DEFAULT 'agent',
  content TEXT NOT NULL DEFAULT '',
  content_ref TEXT,
  created_at TEXT NOT NULL,
  owner_email TEXT NOT NULL DEFAULT 'local@localhost',
  org_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private'
);
CREATE INDEX IF NOT EXISTS tracker_sprint_artifacts_sprint_idx ON tracker_sprint_artifacts (sprint_id, doc_key);
CREATE INDEX IF NOT EXISTS tracker_sprint_artifacts_owner_idx ON tracker_sprint_artifacts (owner_email, org_id)`,
  },
  {
    // M1-4: epic type + decompose-epic. No new columns needed (work_items.type
    // and links.link_type are already free-text); add an index so "find an
    // epic's children" (links WHERE to_item_id = epic AND link_type = 'child-of')
    // and idempotency lookups stay fast.
    version: 15,
    sql: `CREATE INDEX IF NOT EXISTS tracker_links_to_item_type_idx ON tracker_links (to_item_id, link_type)`,
  },
  {
    // M1-3: approval gate sign-off records (plan-signoff/design-signoff/
    // escalation/audit-deferral). Previously the Drizzle schema (schema.ts)
    // declared this table but no CREATE TABLE migration was added, so the
    // table never existed at runtime — request-approval/list-approvals
    // 500'd with "relation tracker_approvals does not exist". Columns match
    // schema.ts's `approvals` table exactly.
    version: 16,
    sql: `CREATE TABLE IF NOT EXISTS tracker_approvals (
  id TEXT PRIMARY KEY,
  sprint_id TEXT NOT NULL,
  work_item_id TEXT,
  gate_key TEXT NOT NULL,
  gate_ref TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by TEXT NOT NULL,
  decided_by TEXT,
  reason TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  owner_email TEXT NOT NULL DEFAULT 'local@localhost',
  org_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private'
);
CREATE INDEX IF NOT EXISTS tracker_approvals_sprint_idx ON tracker_approvals (sprint_id, status);
CREATE INDEX IF NOT EXISTS tracker_approvals_owner_org_idx ON tracker_approvals (owner_email, org_id)`,
  },
  {
    // M1-6: per-project gate criteria config for advance-stage, keyed by
    // stage name. e.g. {"分析":{"requireArtifacts":["sprint-doc"],"requireApproval":"plan-signoff"}}
    version: 17,
    sql: `ALTER TABLE tracker_projects ADD COLUMN IF NOT EXISTS stage_gate_config TEXT NOT NULL DEFAULT '{}'`,
  },
  {
    // M1-7: work item documents — design / prototype / acceptance / spec /
    // other type docs attached to a work item. Each row is one external
    // document URL with a title and doc_type.
    version: 18,
    sql: `CREATE TABLE IF NOT EXISTS tracker_work_item_documents (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  doc_type TEXT NOT NULL DEFAULT 'other',
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  owner_email TEXT NOT NULL DEFAULT 'local@localhost',
  org_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private'
);
CREATE INDEX IF NOT EXISTS tracker_work_item_documents_work_item_idx ON tracker_work_item_documents (work_item_id, doc_type)`,
  },
  {
    // M1-8: sprint 执行相位可见 + executorThreadId 绑定
    version: 19,
    sql: `ALTER TABLE tracker_sprints ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'planning';
ALTER TABLE tracker_sprints ADD COLUMN IF NOT EXISTS executor_thread_id TEXT`,
  },
  {
    // Additive: blocked_by column on exec_queue for dependency-aware dispatch.
    // NOTE: originally numbered 20, but the shared production tracker_migrations
    // table already had version 20 recorded from an independently-developed
    // parallel branch (migrations are tracked by version number only, no content
    // hash, so the numeric collision caused this ALTER to be silently skipped
    // on first deploy) — renumbered to 21 to actually run. See bue067d8s5-adjacent
    // finding: sequential small-integer migration versions collide across
    // parallel SDLC self-bootstrap dev branches; needs a structural fix.
    version: 21,
    sql: `ALTER TABLE tracker_exec_queue ADD COLUMN IF NOT EXISTS blocked_by TEXT NOT NULL DEFAULT '[]'`,
  },
  {
    // B2 签核失效：anchor_artifact_id / anchor_version / stale_at 三列，
    // 用于锚定审批到具体产物版本，产物新版本时把旧审批置 stale 并自动生成重确认审批单。
    version: 22,
    sql: `ALTER TABLE tracker_approvals ADD COLUMN IF NOT EXISTS anchor_artifact_id TEXT;
ALTER TABLE tracker_approvals ADD COLUMN IF NOT EXISTS anchor_version INTEGER;
ALTER TABLE tracker_approvals ADD COLUMN IF NOT EXISTS stale_at TEXT`,
  },
  {
    // B5: artifact reviews — review three-question checkboxes per artifact
    // version. Anchored to (artifact_id, version, review_key).
    version: 23,
    sql: `CREATE TABLE IF NOT EXISTS tracker_artifact_reviews (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  review_key TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0,
  reviewer TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  owner_email TEXT NOT NULL DEFAULT 'local@localhost',
  org_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private'
);
CREATE UNIQUE INDEX IF NOT EXISTS tracker_artifact_reviews_artifact_version_key_idx ON tracker_artifact_reviews (artifact_id, version, review_key)`,
  },
  {
    // F3: 状态迁移守卫 + 派发不推进 + 人工流转通道. exec_state tracks
    // dispatch progress SEPARATELY from currentStageName (which no longer
    // advances on dispatch — see actions/dispatch-to-orchestrator.ts and
    // docs/sdlc-product-design/02-workflows.md §8). closed_reason/closed_at
    // are written by actions/transition-work-item.ts's closed branch.
    version: 24,
    sql: `ALTER TABLE tracker_work_items ADD COLUMN IF NOT EXISTS exec_state TEXT;
ALTER TABLE tracker_work_items ADD COLUMN IF NOT EXISTS closed_reason TEXT;
ALTER TABLE tracker_work_items ADD COLUMN IF NOT EXISTS closed_at TEXT`,
  },
  {
    // F5: 任务拆分阈值(规划前置契约). scale_estimate carries the JSON
    // {files,crossLifecycle,verdict,signals,at} written by
    // actions/estimate-brief-scale.ts / server/lib/scale-runtime-signal.ts.
    // split_parent_id is set on each child row by actions/split-work-item.ts
    // — points back at the over-scale parent it was split from.
    version: 25,
    sql: `ALTER TABLE tracker_work_items ADD COLUMN IF NOT EXISTS scale_estimate TEXT;
ALTER TABLE tracker_work_items ADD COLUMN IF NOT EXISTS split_parent_id TEXT`,
  },
  {
    // F6: hash-collision guard — SEPARATE side table, NOT a column added to
    // `tracker_migrations` itself.
    //
    // R3's design doc literally said "给 tracker_migrations 加 hash TEXT
    // 列"; implementation surfaced a real bug in that plan that isn't visible
    // until you actually run it: core's `runMigrations` records every applied
    // version with an INSERT that has NO explicit column list —
    // `INSERT OR IGNORE INTO tracker_migrations VALUES (?)` on SQLite,
    // `INSERT INTO tracker_migrations VALUES (?) ON CONFLICT DO NOTHING` on
    // Postgres (see packages/core/src/db/migrations.ts's `insertSql`) — both
    // pass exactly ONE positional value (the version) and rely on the table
    // having exactly ONE column. The moment `tracker_migrations` gains a
    // second column (`hash`), that INSERT — used for EVERY migration, not
    // just this one — misbehaves, and the two dialects fail DIFFERENTLY
    // (R3 review F-6 correction; the earlier "both crash" note was wrong):
    //   - SQLite: hard error "table tracker_migrations has 2 columns but 1
    //     values were supplied" (confirmed empirically end-to-end) →
    //     core's outer catch → process.exit(1). Every migration recording
    //     after the column is added crashes the boot.
    //   - Postgres: does NOT crash — a positional INSERT that omits the
    //     trailing column silently records the row with hash = NULL. No
    //     error, but the hash column stays perpetually NULL, so the guard is
    //     blind on Postgres (exactly the dialect production runs on).
    // Either way adding the column is wrong, and fixing it would require
    // changing core's own INSERT — out of bounds (F6 red line "不改 core",
    // precisely to avoid a packages/core changeset). So the hash lives in its
    // own additive table instead — zero interaction with core's bookkeeping
    // INSERT, `tracker_migrations` itself untouched by this migration.
    version: 26,
    sql: `CREATE TABLE IF NOT EXISTS tracker_migration_hashes (
  version INTEGER PRIMARY KEY,
  hash TEXT NOT NULL
)`,
  },
  {
    // F8: 回链完整性 + itemKey 分配权威. Two new tables (both dialects):
    // ① tracker_work_item_runs — append-only dispatch/run history (see
    //    schema.ts for the full rationale; SDLC-053).
    // ② tracker_project_seq — the single atomic itemKey sequencer per
    //    project (SDLC-038). `next_seq` stores the LAST issued number, not
    //    the next one — the atomic allocator's
    //    `UPDATE ... SET next_seq = next_seq + 1 RETURNING next_seq`
    //    pre-increments and returns the freshly allocated number in the
    //    same round trip, so the row must be seeded at the CURRENT max
    //    (not max+1) for the very first post-migration call to correctly
    //    return max+1 (T-F8-02). See server/lib/item-key-sequencer.ts.
    //
    // Backfill (Postgres only): seed every project that already has work
    // items from their current max itemKey numeric suffix, so existing
    // projects never reuse a number. The extraction
    // (`substring(item_key from '[0-9]+$')`) is Postgres regex syntax with
    // no portable SQLite equivalent, so this migration is a table-only
    // no-op on SQLite/libsql (local dev + unit tests) — any project without
    // a row (including every project under SQLite) is seeded lazily on its
    // first allocation call by the same lib function, computing the same
    // "current max itemKey number" via a portable JS-side scan instead of
    // this SQL regex. `ON CONFLICT (project_id) DO NOTHING` makes the
    // backfill safe to layer under that lazy path (whichever runs first
    // for a given project wins; neither clobbers the other).
    version: 27,
    sql: {
      postgres: `CREATE TABLE IF NOT EXISTS tracker_work_item_runs (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  run_id TEXT,
  thread_id TEXT,
  branch TEXT,
  dispatched_at TEXT NOT NULL,
  superseded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  owner_email TEXT NOT NULL DEFAULT 'local@localhost',
  org_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private'
);
CREATE UNIQUE INDEX IF NOT EXISTS tracker_work_item_runs_work_item_run_idx ON tracker_work_item_runs (work_item_id, run_id);
CREATE INDEX IF NOT EXISTS tracker_work_item_runs_work_item_idx ON tracker_work_item_runs (work_item_id, dispatched_at);
CREATE TABLE IF NOT EXISTS tracker_project_seq (
  project_id TEXT PRIMARY KEY,
  next_seq INTEGER NOT NULL
);
INSERT INTO tracker_project_seq (project_id, next_seq)
SELECT project_id, COALESCE(MAX(CAST(NULLIF(substring(item_key from '[0-9]+$'), '') AS INTEGER)), 0)
FROM tracker_work_items
GROUP BY project_id
ON CONFLICT (project_id) DO NOTHING`,
      sqlite: `CREATE TABLE IF NOT EXISTS tracker_work_item_runs (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  run_id TEXT,
  thread_id TEXT,
  branch TEXT,
  dispatched_at TEXT NOT NULL,
  superseded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  owner_email TEXT NOT NULL DEFAULT 'local@localhost',
  org_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private'
);
CREATE UNIQUE INDEX IF NOT EXISTS tracker_work_item_runs_work_item_run_idx ON tracker_work_item_runs (work_item_id, run_id);
CREATE INDEX IF NOT EXISTS tracker_work_item_runs_work_item_idx ON tracker_work_item_runs (work_item_id, dispatched_at);
CREATE TABLE IF NOT EXISTS tracker_project_seq (
  project_id TEXT PRIMARY KEY,
  next_seq INTEGER NOT NULL
)`,
    },
  },
  {
    // v28 (03-tracker.md §8 队列与调度接真): position (manual drag/pin
    // order), waiting_on (unified dependency|health wait descriptor JSON),
    // health_check_log (most recent health-gate rejection JSON) on
    // tracker_exec_queue. See schema.ts's execQueue docblock for the shape.
    version: 28,
    sql: `ALTER TABLE tracker_exec_queue ADD COLUMN IF NOT EXISTS position INTEGER;
ALTER TABLE tracker_exec_queue ADD COLUMN IF NOT EXISTS waiting_on TEXT NOT NULL DEFAULT '{}';
ALTER TABLE tracker_exec_queue ADD COLUMN IF NOT EXISTS health_check_log TEXT`,
  },
  {
    // v29: fixes a pre-existing production bug found while verifying v28 —
    // enqueue-work-item.ts's `.onConflictDoUpdate({ target: workItemId })`
    // requires a real unique constraint/index on work_item_id to plan against.
    // schema.ts has declared `.unique()` on this column since v9, but v9's
    // actual CREATE TABLE text (this file) never carried a UNIQUE constraint
    // for it — so on Postgres, EVERY enqueue call has always thrown
    // "there is no unique or exclusion constraint matching the ON CONFLICT
    // specification" (42P10), even on a first-ever insert (Postgres validates
    // the ON CONFLICT target at plan time, before checking for an actual
    // conflict). Confirmed empirically against 101's production Postgres
    // during this branch's deploy verification. CREATE UNIQUE INDEX IF NOT
    // EXISTS is safe to run on a table that (per the same empirical check)
    // has zero duplicate work_item_id rows.
    //
    // Also note: v9's CREATE TABLE text (above) already contains `position
    // INTEGER NOT NULL DEFAULT 0` and `dequeued_at TEXT` — columns schema.ts
    // has never declared and no ALTER in this file ever added, meaning v9's
    // text drifted from what actually ran in production at some point before
    // the v26 hash-collision guard existed to catch it. Confirmed via psql
    // against 101: `position` is already `bigint NOT NULL DEFAULT 0`, not the
    // nullable column v28 intended — v28's `ADD COLUMN IF NOT EXISTS position`
    // was consequently a no-op there. Application code (app/lib/queue.ts)
    // treats `position <= 0` as "never manually ordered" (matching the
    // existing DEFAULT 0) instead of relying on NULL, so it works against
    // both this legacy shape and a genuinely fresh nullable column.
    version: 29,
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS tracker_exec_queue_work_item_id_key ON tracker_exec_queue (work_item_id)`,
  },
  {
    // v30 (R4b.2 Sprint Studio, r4-workflow-families-planning-skills.md §5.1):
    // studio_state — the one genuinely-new column for Studio's manual
    // step-rail overrides + UI prefs. See schema.ts's sprints docblock.
    version: 30,
    sql: `ALTER TABLE tracker_sprints ADD COLUMN IF NOT EXISTS studio_state TEXT NOT NULL DEFAULT '{}'`,
  },
];

const coreRunMigrations = runMigrations(TRACKER_MIGRATIONS, {
  table: "tracker_migrations",
});

/** Deterministic content hash for one migration entry's SQL. Hashes the
 *  `MigrationSql` value verbatim (string, or the `{postgres,sqlite}` object
 *  serialized) — a change to either dialect branch changes the hash. */
function stableMigrationHash(entry: MigrationEntry): string {
  const canonical =
    typeof entry.sql === "string" ? entry.sql : JSON.stringify(entry.sql);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * F6 hash-collision guard — see `TRACKER_MIGRATIONS`'s version 26 entry above
 * for why the hash lives in its own `tracker_migration_hashes` side table
 * instead of a column on `tracker_migrations` itself, and why this can't live
 * inside core's `runMigrations` (no content hash, only `MAX(version)` skip).
 * Runs as an INDEPENDENT full-table verification pass on every boot, separate
 * from core's version-skip logic — otherwise a same-number-different-content
 * collision would never rerun and never be caught (that's precisely the bug
 * this exists to detect).
 *
 * For every version core's `tracker_migrations` bookkeeping table records as
 * APPLIED (read-only — this function never writes to that table, only to
 * `tracker_migration_hashes`):
 *   - No hash row yet in `tracker_migration_hashes` (pre-F6 history, or a
 *     version applied before this table existed) → backfill it from the
 *     local array now ("first trust").
 *   - Hash row present and matches this branch's local SQL for that version
 *     → no-op.
 *   - Hash row present and DIFFERS → the version number was reused for
 *     different content by some other branch/deploy. Throw explicitly
 *     (`migration-hash-conflict: v<N>`) so startup fails loud instead of
 *     silently running with an unrecorded, unreconciled schema drift.
 *
 * Applied versions this array doesn't know about (e.g. a legacy un-namespaced
 * v1-v3 no-op, or a version owned by a branch not yet merged here) are left
 * untouched — this guard only judges versions THIS branch's array actually
 * defines.
 */
export async function verifyMigrationHashes(): Promise<void> {
  const exec = getDbExec();
  let appliedRows: Array<{ version: number }>;
  let hashRows: Array<{ version: number; hash: string }>;
  try {
    const appliedResult = await exec.execute(
      `SELECT version FROM tracker_migrations`,
    );
    appliedRows = appliedResult.rows as Array<{ version: number }>;
    const hashResult = await exec.execute(
      `SELECT version, hash FROM tracker_migration_hashes`,
    );
    hashRows = hashResult.rows as Array<{ version: number; hash: string }>;
  } catch {
    // `tracker_migration_hashes` isn't there yet — e.g. a dialect
    // permission-limited role skipped v26 (see core's isPermissionError
    // path). Nothing to verify against; defer to the next boot.
    return;
  }

  // Some Postgres drivers return INTEGER columns as strings depending on
  // config — normalize before comparing so lookups never silently miss every
  // row on a dialect where these aren't already JS numbers.
  const hashByVersion = new Map(
    hashRows.map((r) => [Number(r.version), r.hash]),
  );

  for (const row of appliedRows) {
    const version = Number(row.version);
    const entry = TRACKER_MIGRATIONS.find((m) => m.version === version);
    if (!entry) continue; // Version not known to this branch's array — not our call.

    const expected = stableMigrationHash(entry);
    const existingHash = hashByVersion.get(version);
    if (existingHash == null) {
      // `ON CONFLICT DO NOTHING` (target-less form — valid on both SQLite ≥3.24
      // and Postgres) guards against two concurrent serverless cold starts
      // both backfilling the same version's hash between the SELECT above and
      // this INSERT (R3 review F-7): a bare INSERT would race to a PK-violation
      // on the second writer. The value both would insert is identical (same
      // local SQL → same hash), so silently ignoring the loser is correct.
      await exec.execute({
        sql: `INSERT INTO tracker_migration_hashes (version, hash) VALUES (?, ?) ON CONFLICT DO NOTHING`,
        args: [version, expected],
      });
      continue;
    }
    if (existingHash !== expected) {
      throw new Error(`migration-hash-conflict: v${version}`);
    }
  }
}

export default async function trackerDbPlugin(
  nitroApp?: unknown,
): Promise<void> {
  await coreRunMigrations(nitroApp as never);
  await verifyMigrationHashes();
}
