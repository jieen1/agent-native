// f7-telemetry migration smoke test (T-F7-09, 04 §13). Real Postgres, gated
// (default OFF — same `describe.skipIf` gate convention as
// server/runtime/vllm-e2e.spec.ts) because it needs a working `docker` on the
// host. Enable with RUN_DB_MIGRATION_E2E=1.
//
// Boots a one-off `postgres:16` container (F1–F4's documented technique —
// no testcontainers/docker-compose dependency added), points DATABASE_URL at
// it, runs the REAL `server/plugins/db.ts` migration plugin against an EMPTY
// database, and asserts via `information_schema` that the f7-telemetry
// migration actually created `v3_model_registry` + the three new columns.
//
// Manual removal-check (not automated — there is no "comment out this array
// entry" test harness): the implementer verified once by hand that removing
// the `version: 3` migration entry from `V3_MIGRATIONS` and re-running this
// test against a fresh container makes the table/column assertions fail, then
// restored the entry. Documented here rather than faked as a passing
// assertion (the task's own instruction: no textual lock posing as a smoke
// test).

import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";

const enabled = process.env.RUN_DB_MIGRATION_E2E === "1";

function dockerAvailable(): boolean {
  const res = spawnSync("docker", ["ps"], { stdio: "ignore" });
  return res.status === 0;
}

describe.skipIf(!enabled)("f7-telemetry migration smoke (real postgres:16)", () => {
  it(
    "creates v3_model_registry + v3_spawns.model_real_name/usage_suspect + brain_threads.closing_anomaly on an empty DB",
    async () => {
      if (!dockerAvailable()) {
        throw new Error(
          "RUN_DB_MIGRATION_E2E=1 set but `docker` is not available/usable in this environment",
        );
      }

      // Let docker assign a free ephemeral host port (`-p 0:5432`) rather than
      // guessing one — a fixed/random guess races other containers on a busy
      // host ("address already in use"). Read the real mapping back afterwards.
      const cid = execFileSync("docker", [
        "run",
        "-d",
        "--rm",
        "-e",
        "POSTGRES_PASSWORD=postgres",
        "-p",
        "0:5432",
        "postgres:16",
      ])
        .toString()
        .trim();

      try {
        // "0.0.0.0:49153" / "[::]:49153" → 49153.
        const portMapping = execFileSync("docker", ["port", cid, "5432"])
          .toString()
          .trim()
          .split("\n")[0];
        const port = Number(portMapping.slice(portMapping.lastIndexOf(":") + 1));
        if (!Number.isInteger(port) || port <= 0) {
          throw new Error(`could not resolve mapped port from "${portMapping}"`);
        }
        // Wait for readiness (pg_isready inside the container).
        const deadline = Date.now() + 30_000;
        let ready = false;
        while (Date.now() < deadline) {
          const res = spawnSync("docker", ["exec", cid, "pg_isready", "-U", "postgres"]);
          if (res.status === 0) {
            ready = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        if (!ready) throw new Error("postgres:16 container never became ready");

        const databaseUrl = `postgres://postgres:postgres@localhost:${port}/postgres`;
        // MUST be set before anything transitively imports @agent-native/core/db
        // in this process — its dialect/connection resolution is memoized on
        // first read.
        process.env.DATABASE_URL = databaseUrl;

        const dbPluginModule = await import("./db.js");
        await dbPluginModule.default(undefined);

        const postgres = (await import("postgres")).default;
        const sql = postgres(databaseUrl);
        try {
          const tableRows = await sql`SELECT to_regclass('public.v3_model_registry') AS reg`;
          expect(tableRows[0]?.reg).not.toBeNull();

          const cols = await sql`
            SELECT table_name, column_name FROM information_schema.columns
            WHERE (table_name = 'v3_spawns' AND column_name IN ('model_real_name', 'usage_suspect'))
               OR (table_name = 'brain_threads' AND column_name = 'closing_anomaly')
            ORDER BY table_name, column_name
          `;
          const names = cols.map((c) => `${c.table_name}.${c.column_name}`);
          expect(names).toEqual([
            "brain_threads.closing_anomaly",
            "v3_spawns.model_real_name",
            "v3_spawns.usage_suspect",
          ]);

          // Additive sanity: the pre-existing v3_spawns.tokens_input/tokens_output
          // columns (already there before this migration) are untouched.
          const preExisting = await sql`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'v3_spawns' AND column_name IN ('tokens_input', 'tokens_output')
            ORDER BY column_name
          `;
          expect(preExisting.map((c) => c.column_name)).toEqual([
            "tokens_input",
            "tokens_output",
          ]);
        } finally {
          await sql.end();
        }
      } finally {
        spawnSync("docker", ["stop", cid], { stdio: "ignore" });
      }
    },
    120_000,
  );
});
