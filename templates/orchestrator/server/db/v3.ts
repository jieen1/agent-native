// V3 Postgres database connection (DESIGN §3).
// Dual database strategy: V2 uses LibSQL via getDb(), V3 uses Postgres.
// The connections are independent — V3 does not interfere with V2.

import { drizzle } from "drizzle-orm/postgres-js";
import $ from "postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

// Re-export schema so consumers import from this module
import * as v3Schema from "./v3-schema.js";
export { v3Schema };
export type * from "./v3-schema.js";

/**
 * Resolve the Postgres connection string for V3.
 * Uses DATABASE_URL_PG environment variable.
 */
function v3DatabaseUrl(): string {
  const url = process.env.DATABASE_URL_PG;
  if (!url) {
    throw new Error(
      "DATABASE_URL_PG not set. V3 requires a Postgres database. " +
        "Set DATABASE_URL_PG to a Postgres connection string.",
    );
  }
  return url;
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
