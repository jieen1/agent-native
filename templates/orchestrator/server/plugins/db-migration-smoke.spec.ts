// F1 workspace contract — T-F1-13: v3 migration smoke against a REAL
// disposable Postgres (docs/sdlc-impl-f1-f4.md §6.1). The B5 lesson made
// explicit: an in-memory/libsql DB with a self-built schema is NOT evidence
// that a migration creates real columns — Postgres semantics (JSONB,
// TIMESTAMPTZ, native enums, ALTER TYPE ... ADD VALUE) only exist on
// Postgres. This spec boots a one-shot `postgres:16-alpine` container,
// applies EVERY exported v3 migration entry in order onto the empty
// database, and asserts:
//   • base_sha / ready_at / ready_report exist on v3_workspaces with the
//     correct data types (the `f1-workspace-contract` named migration);
//   • the 'failed' value landed in the v3_workspace_state enum;
//   • every v3 table exists (full-breadth per the T-F1-13 judgement);
//   • re-running the f1 migration's SQL is idempotent (IF NOT EXISTS).
//
// Skips (does not fail) when no usable docker daemon is present, so the
// suite stays runnable on hosts without docker; on the dev box docker is
// available and the smoke is REAL.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";

import { V3_MIGRATIONS } from "./db.js";

const CONTAINER = `f1-migration-smoke-${process.pid}`;
// Resolved AFTER `docker run` publishes 5432 onto an EPHEMERAL host port
// (`-p 127.0.0.1::5432`) — a fixed host port collides with the other agents'
// (and this repo's) postgres containers on the shared box.
let PG_URL = "";

function sh(cmd: string, args: string[], input?: string) {
  const res = spawnSync(cmd, args, { encoding: "utf8", input });
  return {
    code: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

const dockerAvailable = sh("docker", ["info"]).code === 0;
const psqlAvailable = sh("psql", ["--version"]).code === 0;
const canRun = dockerAvailable && psqlAvailable;

/** Run `sql` through psql; throws on non-zero exit (ON_ERROR_STOP). */
function psql(sql: string): string {
  const res = sh(
    "psql",
    [PG_URL, "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    sql,
  );
  if (res.code !== 0) {
    throw new Error(`psql failed (exit ${res.code}): ${res.stderr}`);
  }
  return res.stdout.trim();
}

describe.skipIf(!canRun)(
  "T-F1-13: v3 migrations on a disposable real Postgres",
  () => {
    beforeAll(async () => {
      sh("docker", ["rm", "-f", CONTAINER]); // stale container from a crashed run
      const started = sh("docker", [
        "run",
        "-d",
        "--rm",
        "--name",
        CONTAINER,
        "-e",
        "POSTGRES_PASSWORD=f1-smoke-local-only",
        // Ephemeral host port — docker picks a free one; we read it back below.
        "-p",
        "127.0.0.1::5432",
        "postgres:16-alpine",
      ]);
      if (started.code !== 0) {
        throw new Error(`docker run failed: ${started.stderr}`);
      }
      // Resolve the host port docker assigned (e.g. "127.0.0.1:49153").
      const portLine = sh("docker", ["port", CONTAINER, "5432/tcp"])
        .stdout.split("\n")
        .map((l) => l.trim())
        .filter(Boolean)[0];
      const hostPort = portLine?.split(":").pop();
      if (!hostPort) {
        throw new Error(`could not resolve mapped host port: '${portLine}'`);
      }
      PG_URL = `postgresql://postgres:f1-smoke-local-only@127.0.0.1:${hostPort}/postgres`;
      // Wait for Postgres to accept connections (fresh alpine boots in ~2-5s).
      const deadline = Date.now() + 60_000;
      for (;;) {
        const probe = sh("psql", [PG_URL, "-tA", "-c", "select 1"]);
        if (probe.code === 0 && probe.stdout.trim() === "1") break;
        if (Date.now() > deadline) {
          throw new Error(`Postgres did not become ready: ${probe.stderr}`);
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }, 120_000);

    afterAll(() => {
      sh("docker", ["rm", "-f", CONTAINER]);
    });

    it("applies all v3 migrations in order on an EMPTY database, then the F1 columns/enum/tables are real", () => {
      // ── Apply every exported entry in version order ─────────────────────────
      const entries = [...V3_MIGRATIONS].sort((a, b) => a.version - b.version);
      expect(entries.length).toBeGreaterThanOrEqual(3);
      for (const entry of entries) {
        const sql =
          typeof entry.sql === "string"
            ? entry.sql
            : (entry.sql as { postgres?: string }).postgres;
        if (!sql) continue; // dialect-gated with no postgres SQL (none today)
        psql(sql);
      }

      // ── f1-workspace-contract: the three columns, with correct types ────────
      const cols = psql(
        `SELECT column_name || ':' || data_type
         FROM information_schema.columns
        WHERE table_name = 'v3_workspaces'
          AND column_name IN ('base_sha', 'ready_at', 'ready_report')
        ORDER BY column_name`,
      )
        .split("\n")
        .filter(Boolean);
      expect(cols).toEqual([
        "base_sha:text",
        "ready_at:timestamp with time zone",
        "ready_report:jsonb",
      ]);

      // ── the 'failed' workspace state landed in the native enum ──────────────
      const enumValues = psql(
        `SELECT e.enumlabel
         FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'v3_workspace_state'
        ORDER BY e.enumsortorder`,
      )
        .split("\n")
        .filter(Boolean);
      expect(enumValues).toContain("failed");
      // The original six states are all still present (additive only).
      for (const v of [
        "provisioning",
        "ready",
        "busy",
        "destroying",
        "destroyed",
        "error",
      ]) {
        expect(enumValues).toContain(v);
      }

      // ── full breadth: every v3 table exists on the fresh database ───────────
      const tables = psql(
        `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`,
      )
        .split("\n")
        .filter(Boolean);
      for (const t of [
        "brain_events",
        "brain_tasks",
        "brain_threads",
        "spawn_events",
        "v3_artifacts",
        "v3_events",
        "v3_nodes",
        "v3_patches",
        "v3_runs",
        "v3_spawns",
        "v3_workflow_templates",
        "v3_workspaces",
      ]) {
        expect(tables).toContain(t);
      }

      // ── a row exercising the new columns + enum value round-trips ───────────
      psql(
        `INSERT INTO v3_workspaces (id, owner_kind, owner_id, state, base_sha, ready_at, ready_report)
       VALUES ('smoke-ws', 'run', 'run-smoke', 'failed', 'abc123',
               now(), '{"w1":{"ok":true}}'::jsonb)`,
      );
      const roundTrip = psql(
        `SELECT state || '|' || base_sha || '|' || (ready_report->'w1'->>'ok')
         FROM v3_workspaces WHERE id = 'smoke-ws'`,
      );
      expect(roundTrip).toBe("failed|abc123|true");

      // ── idempotency: re-running the f1 named migration is a no-op ───────────
      const f1 = entries.find(
        (e) => (e as { name?: string }).name === "f1-workspace-contract",
      );
      expect(f1).toBeDefined();
      const f1Sql = (f1!.sql as { postgres: string }).postgres;
      psql(f1Sql); // ADD COLUMN IF NOT EXISTS / ADD VALUE IF NOT EXISTS — must not throw
    }, 120_000);
  },
);

describe("T-F1-13 static shape (always runs, docker or not)", () => {
  it("the f1-workspace-contract entry exists, is named, additive-only, and Postgres-gated", () => {
    const f1 = V3_MIGRATIONS.find(
      (e) => (e as { name?: string }).name === "f1-workspace-contract",
    );
    expect(f1).toBeDefined();
    const sql = (f1!.sql as { postgres: string }).postgres;
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS base_sha");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS ready_at");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS ready_report");
    expect(sql).toContain("ADD VALUE IF NOT EXISTS 'failed'");
    // Additive discipline: no destructive DDL anywhere in the entry.
    expect(sql).not.toMatch(/\b(DROP|TRUNCATE|RENAME)\b/i);
  });
});
