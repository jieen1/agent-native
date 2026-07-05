// V3 Postgres database connection (DESIGN §3).
// Dual database strategy: V2 uses LibSQL via getDb(), V3 uses Postgres.
// The connections are independent — V3 does not interfere with V2.

import { drizzle } from "drizzle-orm/postgres-js";
import $ from "postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

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

// Re-export schema so consumers import from this module
import * as v3Schema from "./v3-schema.js";
export { v3Schema };
export type * from "./v3-schema.js";

/**
 * Resolve the Postgres connection string for V3.
 * Prefers an explicit DATABASE_URL_PG, but falls back to the standard
 * DATABASE_URL when it already points at Postgres — the common single-database
 * deployment where the whole app runs on one Postgres instance.
 */
function v3DatabaseUrl(): string {
  const explicit = process.env.DATABASE_URL_PG;
  if (explicit) return explicit;
  const fallback = process.env.DATABASE_URL;
  if (fallback && /^postgres(ql)?:\/\//.test(fallback)) {
    return fallback;
  }
  throw new Error(
    "V3 requires a Postgres database. Set DATABASE_URL_PG (or a Postgres " +
      "DATABASE_URL) to a Postgres connection string.",
  );
}

/**
 * Singleton Postgres client and Drizzle database for V3.
 * Lazy-initialized on first call.
 */
let v3DbInstance: PostgresJsDatabase<typeof v3Schema> | null = null;
let v3PgClient: ReturnType<typeof $> | null = null;

/**
 * Get the V3 Postgres Drizzle database instance.
 * Returns a PostgresJsDatabase typed with the V3 schema.
 * Connection pool: postgres.js default (pool=10), configurable via ?pool= in URL.
 */
export function getV3Db(): PostgresJsDatabase<typeof v3Schema> {
  if (v3DbInstance) return v3DbInstance;

  const url = v3DatabaseUrl();
  const pg = $(url, {
    // Small pool for orchestrator workloads. Override via URL ?pool= param.
    max: 10,
    // Idle timeout to release connections on serverless.
    idle_timeout: 20,
    // Connect timeout.
    connect_timeout: 30,
  });

  v3PgClient = pg;
  v3DbInstance = drizzle(pg, { schema: v3Schema });
  return v3DbInstance;
}

/**
 * Get the raw postgres.js client for V3 (pooled). Initializes the pool on first
 * use via getV3Db(). Use this when you need a SINGLE-connection scope — e.g. a
 * transaction (`pg.begin(...)`) or a session-scoped feature like an advisory
 * lock — that v3DbExec (which runs each statement on an arbitrary pooled
 * connection) cannot provide. Returns null when V3 Postgres is not configured.
 */
export function getV3PgClient(): ReturnType<typeof $> | null {
  if (!v3PgClient) {
    if (!isV3PostgresConfigured()) return null;
    getV3Db(); // lazily initialize the pool + v3PgClient
  }
  return v3PgClient;
}

/**
 * Close the V3 Postgres connection. Use for scripts that need cleanup.
 */
export async function closeV3Db(): Promise<void> {
  if (v3PgClient) {
    await v3PgClient.end();
    v3PgClient = null;
    v3DbInstance = null;
  }
}

/**
 * Run raw SQL against the V3 Postgres database.
 * Useful for migrations and DDL that Drizzle doesn't express.
 */
export async function v3DbExec(sql: string, params?: unknown[]): Promise<{
  rows: any[];
  rowsAffected: number;
}> {
  const pg = v3PgClient;
  if (!pg) throw new Error("V3 DB not initialized");
  const result = await pg.unsafe(sql, params as any[]);
  return {
    rows: result || [],
    rowsAffected: result?.length ?? 0,
  };
}

/**
 * True when V3's Postgres connection is configured — either an explicit
 * DATABASE_URL_PG or a standard DATABASE_URL that points at Postgres.
 */
export function isV3PostgresConfigured(): boolean {
  if (process.env.DATABASE_URL_PG) return true;
  const url = process.env.DATABASE_URL;
  return !!url && /^postgres(ql)?:\/\//.test(url);
}

/**
 * Ensure the V3 schema exists by applying the generated drizzle migration SQL
 * idempotently (CREATE TABLE/INDEX IF NOT EXISTS). Runs once on startup; safe to
 * repeat. Best-effort: failures are logged, never thrown, so boot is not blocked.
 */
export async function ensureV3Schema(): Promise<void> {
  if (!isV3PostgresConfigured()) return;
  const candidates = [
    join(process.cwd(), "server/db/v3-migrations"),
    join(process.cwd(), "templates/orchestrator/server/db/v3-migrations"),
  ];
  const dir = candidates.find((d) => existsSync(d));
  if (!dir) {
    console.warn("[v3-migrate] migrations directory not found; skipping schema ensure");
    return;
  }
  getV3Db(); // initialize the pooled client used by v3DbExec
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const content = readFileSync(join(dir, file), "utf-8")
      .replace(/CREATE TABLE "/g, 'CREATE TABLE IF NOT EXISTS "')
      .replace(/CREATE INDEX "/g, 'CREATE INDEX IF NOT EXISTS "')
      .replace(/CREATE UNIQUE INDEX "/g, 'CREATE UNIQUE INDEX IF NOT EXISTS "');
    const statements = content
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      try {
        await v3DbExec(stmt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/already exists/i.test(msg)) {
          console.warn(`[v3-migrate] statement failed: ${msg}`);
        }
      }
    }
  }
  console.log("[v3-migrate] V3 schema ensured");
}
