import { createGetDb, getDbExec } from "@agent-native/core/db";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { registerShareableResource } from "@agent-native/core/sharing";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "./schema.js";
import * as v3Schema from "./v3-schema.js";

// V3 (DESIGN §3) used to run on its OWN Postgres connection (server/db/v3.ts,
// now deleted) even though it targets the SAME physical Postgres database as
// V2 on every deployed environment. The two schema modules were merged here
// so every V3 consumer reads/writes through the ONE framework `getDb()` pool
// instead of a second independent pool — a pure access-layer migration; no
// table/row was moved. There are no table-name collisions between `schema`
// and `v3-schema` (verified), so a flat merge is safe.
const mergedSchema = { ...schema, ...v3Schema };

export const getDb = createGetDb(mergedSchema);
/** The Drizzle db instance type returned by `getDb()`, for typing default params. */
export type OrchestratorDb = ReturnType<typeof getDb>;
// Re-export the raw db-exec client (used by the queue's portable atomic claim /
// reap, which need affected-row counts that the Drizzle query builder does not
// surface) so the rest of the app imports it through one local module.
export { schema, v3Schema, getDbExec };

/**
 * Typed accessor for V3 code that needs Drizzle's query builder (`.select()`,
 * `.update()`, `.insert()`, `.execute(sql.raw(...))`) against v3-schema.ts
 * tables — the SAME singleton connection as `getDb()`, NOT a second pool.
 *
 * Why this exists (a TypeScript limitation, not an architectural split):
 * `createGetDb()`'s declared return type is always `LibSQLDatabase<T>`,
 * because the framework's dialect-agnostic schema helpers
 * (`@agent-native/core/db/schema.js`'s `table()`/`text()`/`integer()`, used by
 * `./schema.js`) are typed as `typeof sqliteTable` regardless of the runtime
 * dialect — that's how v2's schema stays valid Drizzle input on both SQLite
 * and Postgres. v3-schema.ts instead imports REAL `drizzle-orm/pg-core`
 * (`pgTable`/`jsonb`/`timestamp`/`pgEnum`) because V3 is Postgres-only and
 * needs column types (jsonb, timestamptz, native enums) the dialect-agnostic
 * helper has no equivalent for — the "core insight" of this migration
 * deliberately keeps those native types instead of converting them to text.
 * That means v3-schema.ts's tables are genuine `PgTable`/`PgColumn` objects,
 * which are structurally INCOMPATIBLE with `LibSQLDatabase<T>`'s SQLite-typed
 * query-builder methods — `tsc` rejects `db.select({ id: v3Runs.id })` etc.
 * against a `LibSQLDatabase`-typed `db`, even though at RUNTIME, on Postgres,
 * `getDb()` is genuinely a `PostgresJsDatabase<typeof mergedSchema>` instance
 * (`drizzle(pool, { schema: mergedSchema })` via `drizzle-orm/postgres-js` —
 * see `createGetDb` in packages/core). This function re-asserts that real
 * type for V3 call sites. Safe because V3 has never run on SQLite/D1/pglite.
 */
export function getV3Db(): PostgresJsDatabase<typeof v3Schema> {
  return getDb() as unknown as PostgresJsDatabase<typeof v3Schema>;
}

/**
 * The local single-user owner identity. Every V3 row is CREATED with
 * `ownerEmail = getRequestUserEmail() ?? LOCAL_DEFAULT_OWNER` (see the write
 * actions + the `ownableColumns()` column default in v3-schema.ts), so reads
 * MUST resolve the same value or a self-host caller would never see its own
 * rows.
 */
export const LOCAL_DEFAULT_OWNER = "local@localhost";

/**
 * Resolve the owner-scope identity for a V3 read or write, FAIL-CLOSED.
 *
 * Mirrors the exact write-side default the V3 actions already use
 * (`getRequestUserEmail() ?? "local@localhost"`), so:
 *  - an authenticated request is always constrained to the caller's own rows;
 *  - a self-host request with no resolved identity resolves to the local
 *    single-user owner — NOT "all owners".
 *
 * This NEVER returns undefined, so callers can apply the owner filter
 * unconditionally. That is the fix for the O9 fail-open pattern where the owner
 * filter was gated behind `if (ownerEmail)` and an empty identity returned every
 * owner's rows. A request can never read or write another owner's V3 rows: a
 * real hosted user's rows are owned by their real email (never
 * "local@localhost"), so an unauthenticated caller resolving to
 * "local@localhost" cannot reach them.
 */
export function resolveOwnerEmail(): string {
  return getRequestUserEmail() ?? LOCAL_DEFAULT_OWNER;
}

registerShareableResource({
  type: "task",
  resourceTable: schema.tasks,
  sharesTable: schema.taskShares,
  displayName: "Task",
  titleColumn: "title",
  getResourcePath: (task) => `/tasks/${(task as { id: string }).id}`,
  getDb,
});

registerShareableResource({
  type: "workflow",
  resourceTable: schema.workflows,
  sharesTable: schema.workflowShares,
  displayName: "Workflow",
  titleColumn: "name",
  getResourcePath: (wf) => `/workflows/${(wf as { id: string }).id}`,
  getDb,
});

// ── v2 graph engine ownable resources ──────────────────────────────────────

registerShareableResource({
  type: "workflow_template",
  resourceTable: schema.workflowTemplates,
  sharesTable: schema.workflowTemplateShares,
  displayName: "Workflow Template",
  titleColumn: "name",
  getResourcePath: (t) => `/templates/${(t as { id: string }).id}`,
  getDb,
});

registerShareableResource({
  type: "workflow_run",
  resourceTable: schema.workflowRuns,
  sharesTable: schema.workflowRunShares,
  displayName: "Workflow Run",
  titleColumn: "id",
  getResourcePath: (r) => `/runs/${(r as { id: string }).id}`,
  getDb,
});

// ── v2 project-management ownable resources (P3a) ───────────────────────────

registerShareableResource({
  type: "project",
  resourceTable: schema.projects,
  sharesTable: schema.projectShares,
  displayName: "Project",
  titleColumn: "name",
  getResourcePath: (p) => `/projects/${(p as { id: string }).id}`,
  getDb,
});

registerShareableResource({
  type: "work_item",
  resourceTable: schema.workItems,
  sharesTable: schema.workItemShares,
  displayName: "Work Item",
  titleColumn: "title",
  getResourcePath: (w) => `/work-items/${(w as { id: string }).id}`,
  getDb,
});

registerShareableResource({
  type: "node_def",
  resourceTable: schema.nodeDefs,
  sharesTable: schema.nodeDefShares,
  displayName: "Node Definition",
  titleColumn: "title",
  getResourcePath: (n) => `/library/${(n as { id: string }).id}`,
  getDb,
});

registerShareableResource({
  type: "agent_def",
  resourceTable: schema.agentDefs,
  sharesTable: schema.agentDefShares,
  displayName: "Agent Definition",
  titleColumn: "name",
  getResourcePath: (a) => `/agents/${(a as { id: string }).id}`,
  getDb,
});
