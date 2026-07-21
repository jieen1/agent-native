import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createClient, type Client } from "@libsql/client";
import { getTableName } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as trackerSchema from "../../db/schema.js";

// ============================================================================
// T-F3-12: tracker v24 迁移冒烟
// T-F5-07 (docs/sdlc-impl-f5-f10.md §1E): 承接同一个 it() 块 — 在其列存在性
// 断言旁追加 scale_estimate/split_parent_id 两列(v25, F5 任务拆分阈值)。
// 不新建 migration-smoke.test.ts 或第二个 it()(§1E 原文明确要求"扩展,非新建")。
//
// docs/sdlc-impl-f1-f4.md §6.3 T-F3-12 目标: "B5 教训成文: 内存库自建 schema
// 不算建表证据" — 要求 "一次性真 Postgres 空库顺序跑 v1…v24 全部迁移" 并
// "全量断言 schema.ts 声明的所有表存在".
//
// This test runs the REAL migration runner (server/plugins/db.ts's
// `runMigrations([...], { table: "tracker_migrations" })`) — NOT a
// hand-rolled CREATE TABLE fixture — against a throwaway LOCAL SQLite file,
// which is a genuine (if partial) regression check: it catches SQL syntax
// errors, ordering bugs, and missing migrations in the real migration file.
//
// What it does NOT substitute for: the doc's explicit requirement is a real
// EMPTY POSTGRES DATABASE. This sandbox has no live Postgres reachable, so
// the authoritative Postgres-empty-db run is DEFERRED to deployment
// verification (101's real Postgres, per the team's remote-101-* runbooks).
// The `it.skip` below documents this explicitly with the skip reason, per
// the B5 lesson: a green SQLite smoke test must never be mistaken for the
// real acceptance evidence.
// ============================================================================

let dbDir: string;
let dbPath: string;
let originalDatabaseUrl: string | undefined;

beforeAll(() => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-migration-smoke-"));
  dbPath = path.join(dbDir, "smoke.db");
  originalDatabaseUrl = process.env.DATABASE_URL;
  // Point the framework's real getDbExec() singleton (which the migration
  // runner uses internally) at an isolated, throwaway file — never the
  // template's real local dev DB (templates/tracker/data/app.db).
  process.env.DATABASE_URL = `file:${dbPath}`;
});

afterAll(async () => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  const { closeDbExec } = await import("@agent-native/core/db");
  await closeDbExec?.().catch(() => {});
  fs.rmSync(dbDir, { recursive: true, force: true });
});

describe("T-F3-12 / T-F5-07 / T-F6-08: tracker v24/v25/v26 迁移冒烟 (SQLite best-effort smoke)", () => {
  it("running the REAL migration file end-to-end (v1..v26) succeeds and produces every table schema.ts declares", async () => {
    const dbPluginModule = await import("../db.js");
    const runMigrationsPlugin =
      dbPluginModule.default as unknown as () => Promise<void>;
    await runMigrationsPlugin();

    const inspect: Client = createClient({ url: `file:${dbPath}` });
    try {
      const tableRows = await inspect.execute(
        "SELECT name FROM sqlite_master WHERE type='table'",
      );
      const tableNames = new Set(
        tableRows.rows.map((r: any) => String(r.name)),
      );

      // Every table schema.ts declares as a Drizzle table object must exist.
      const declaredTables = Object.values(trackerSchema)
        .filter((v) => typeof v === "object" && v !== null)
        .map((t) => {
          try {
            return getTableName(t as any);
          } catch {
            return null;
          }
        })
        .filter((n): n is string => typeof n === "string");

      expect(declaredTables.length).toBeGreaterThan(0);
      for (const name of declaredTables) {
        expect(tableNames.has(name)).toBe(true);
      }

      // v24: the three F3 columns exist on tracker_work_items.
      const cols = await inspect.execute(
        "PRAGMA table_info(tracker_work_items)",
      );
      const colNames = new Set(cols.rows.map((r: any) => String(r.name)));
      expect(colNames.has("exec_state")).toBe(true);
      expect(colNames.has("closed_reason")).toBe(true);
      expect(colNames.has("closed_at")).toBe(true);

      // v25 (T-F5-07, F5 任务拆分阈值): scale_estimate + split_parent_id.
      expect(colNames.has("scale_estimate")).toBe(true);
      expect(colNames.has("split_parent_id")).toBe(true);

      // T-F6-08: v26 adds the hash-tracking table (F6 §2C — see db.ts's v26
      // entry for why this is a SEPARATE `tracker_migration_hashes` table
      // rather than a `hash` column bolted onto `tracker_migrations` itself:
      // core's own bookkeeping INSERT for that table has no explicit column
      // list and assumes exactly one column, so adding a second column there
      // breaks recording EVERY subsequent migration, not just this one — a
      // real bug found empirically during implementation, not a documentation
      // nuance). Extended into this SAME it() block per docs/sdlc-impl-f5-f10.md
      // §2E T-F6-08's explicit instruction — not a new it()/file (T-F5-07
      // already established this "extend, don't duplicate" precedent for v25).
      const hashTableRows = await inspect.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='tracker_migration_hashes'",
      );
      expect(hashTableRows.rows.length).toBe(1);

      // And it's not just present — every applied version's hash was actually
      // backfilled by verifyMigrationHashes() (T-F6-05's "首次回填" behavior,
      // exercised here for free since this is a from-scratch empty-db run).
      const migRows = await inspect.execute(
        "SELECT version, hash FROM tracker_migration_hashes",
      );
      expect(migRows.rows.length).toBeGreaterThan(0);
      for (const row of migRows.rows as unknown as Array<{
        version: number;
        hash: string | null;
      }>) {
        expect(
          row.hash,
          `version ${row.version} should have a backfilled hash`,
        ).toBeTruthy();
      }

      // T-F8-06 (SQLite tier): v27's two new tables exist. The Postgres-only
      // regex-substring backfill INSERT is a no-op on this dialect (see
      // db.ts's v27 comment) — table PRESENCE is all SQLite can prove; the
      // backfill CONTENT (next_seq = legacy max for a pre-existing project)
      // is deployment-window evidence, reproducible via the committed
      // scripts/f8-pg-verify.mts (PHASE 2), see the it.skip below.
      expect(tableNames.has("tracker_work_item_runs")).toBe(true);
      expect(tableNames.has("tracker_project_seq")).toBe(true);
      const runCols = await inspect.execute(
        "PRAGMA table_info(tracker_work_item_runs)",
      );
      const runColNames = new Set(runCols.rows.map((r: any) => String(r.name)));
      for (const c of [
        "work_item_id",
        "run_id",
        "thread_id",
        "branch",
        "superseded",
      ]) {
        expect(runColNames.has(c)).toBe(true);
      }
      const seqCols = await inspect.execute(
        "PRAGMA table_info(tracker_project_seq)",
      );
      const seqColNames = new Set(seqCols.rows.map((r: any) => String(r.name)));
      expect(seqColNames.has("project_id")).toBe(true);
      expect(seqColNames.has("next_seq")).toBe(true);
    } finally {
      inspect.close();
    }
  }, 30_000);

  it.skip(
    "REQUIRES real empty Postgres — deferred to deployment verification " +
      "(B5: a SQLite smoke pass is not migration-application evidence; the " +
      "SQLite it() above is best-effort only). Boot the app once against a " +
      "one-time empty Postgres db (DATABASE_URL=postgres://.../throwaway_db) " +
      "so the real server/plugins/db.ts plugin applies v1..v27, then query " +
      "information_schema.columns for exec_state/closed_reason/closed_at " +
      "(v24), scale_estimate/split_parent_id (v25, F5) on tracker_work_items, " +
      "confirm every applied version got backfilled into " +
      "tracker_migration_hashes (v26, F6), plus information_schema.tables for " +
      "every table above (including v27's tracker_work_item_runs/" +
      "tracker_project_seq, F8). Two committed scripts cover this: " +
      "scripts/run-migrations-smoke.ts (generic column-presence proof, " +
      "dialect-agnostic via core getDbExec — pnpm exec tsx " +
      "scripts/run-migrations-smoke.ts) and scripts/f8-pg-verify.mts (F8's " +
      "PHASE 1, same v1..v27 apply + table/column assertions) — see each " +
      "file's header for the exact command.",
    () => {},
  );
});

// ============================================================================
// T-F6-03: 冒烟档有效性 —— 删除迁移必须显式变红
//
// docs/sdlc-impl-f5-f10.md §2E T-F6-03: "注入:临时删 v23 建表迁移块,跑
// migration-smoke → 断言失败点名缺失表;恢复后全绿". Implemented as a real,
// permanent, automated regression test (not a manual edit-and-revert dance):
// doctor an IN-MEMORY COPY of the real `TRACKER_MIGRATIONS` array (v23's SQL
// replaced with a no-op — the exact real SDLC-061 incident this smoke test
// exists to catch, see that entry's own comment in db.ts), run it through
// core's real `runMigrations` against an isolated throwaway db, and assert
// BOTH that the table is genuinely absent (what a smoke assertion would catch)
// AND that `auditMigrations()` names it precisely.
//
// Uses TWO SEPARATE fresh throwaway dbs (one for "red", one for "green")
// rather than one db shared across a doctored-then-real re-run: re-running
// the REAL array in the SAME db/bookkeeping-table context the mutated array
// already used would hit core's version-skip (`version > MAX(recorded)`) and
// never re-apply v23 at all — proving nothing about "restore" (a separate,
// well-understood mechanism, not what this test is about). Two independent
// fresh dbs sidestep that entirely: each is a from-scratch v1..v26 run, one
// with v23 doctored, one with the real array.
// ============================================================================

describe("T-F6-03: 冒烟档有效性(删迁移必红/恢复必绿)", () => {
  it("removing v23's CREATE TABLE for tracker_artifact_reviews makes the table absent + auditMigrations() names it exactly (SDLC-061 replay)", async () => {
    const { closeDbExec, runMigrations } =
      await import("@agent-native/core/db");
    await closeDbExec?.().catch(() => {});
    const dbDirRed = fs.mkdtempSync(
      path.join(os.tmpdir(), "tracker-migration-smoke-red-"),
    );
    const dbPathRed = path.join(dbDirRed, "red.db");
    process.env.DATABASE_URL = `file:${dbPathRed}`;

    try {
      const dbPluginModule = (await import("../db.js")) as unknown as {
        TRACKER_MIGRATIONS: Array<{ version: number; sql: string }>;
      };
      const realMigrations = dbPluginModule.TRACKER_MIGRATIONS;
      expect(realMigrations.some((m) => m.version === 23)).toBe(true);

      const mutated = realMigrations.map((m) =>
        m.version === 23 ? { ...m, sql: `SELECT 1` } : m,
      );

      // Real bookkeeping table name — required so v26's hardcoded ALTER
      // TABLE tracker_migrations target actually exists (see block comment).
      const runMutated = runMigrations(mutated, {
        table: "tracker_migrations",
      });
      await runMutated(undefined as never);

      const { createClient } = await import("@libsql/client");
      const inspect = createClient({ url: `file:${dbPathRed}` });
      try {
        const tableRows = await inspect.execute(
          "SELECT name FROM sqlite_master WHERE type='table'",
        );
        const tableNames = new Set(
          tableRows.rows.map((r: any) => String(r.name)),
        );

        // RED: genuinely absent — exactly what the T-F3-12 smoke assertion catches.
        expect(tableNames.has("tracker_artifact_reviews")).toBe(false);

        // And migration-audit's pure function names it precisely, not just
        // "something's wrong" (03 §2's "精确名单").
        const { auditMigrations, resolveRuntimeSchemaSource } =
          await import("../../lib/migration-audit.js");
        const schemaSource = await resolveRuntimeSchemaSource();
        const mutatedMigrationsText = mutated.map((m) => m.sql).join("\n");
        const audit = auditMigrations(schemaSource, mutatedMigrationsText);
        expect(audit.missing).toContain("tracker_artifact_reviews");
      } finally {
        inspect.close();
      }
    } finally {
      await closeDbExec?.().catch(() => {});
      fs.rmSync(dbDirRed, { recursive: true, force: true });
    }
  }, 30_000);

  it("running the REAL (undoctored) array fresh creates tracker_artifact_reviews — 'restore → all green' (same real bookkeeping name, independent fresh db)", async () => {
    const { closeDbExec, runMigrations } =
      await import("@agent-native/core/db");
    await closeDbExec?.().catch(() => {});
    const dbDirGreen = fs.mkdtempSync(
      path.join(os.tmpdir(), "tracker-migration-smoke-green-"),
    );
    const dbPathGreen = path.join(dbDirGreen, "green.db");
    process.env.DATABASE_URL = `file:${dbPathGreen}`;

    try {
      const dbPluginModule = (await import("../db.js")) as unknown as {
        TRACKER_MIGRATIONS: Array<{ version: number; sql: string }>;
      };
      const realMigrations = dbPluginModule.TRACKER_MIGRATIONS;

      const runReal = runMigrations(realMigrations, {
        table: "tracker_migrations",
      });
      await runReal(undefined as never);

      const { createClient } = await import("@libsql/client");
      const inspect = createClient({ url: `file:${dbPathGreen}` });
      try {
        const tableRows = await inspect.execute(
          "SELECT name FROM sqlite_master WHERE type='table'",
        );
        const tableNames = new Set(
          tableRows.rows.map((r: any) => String(r.name)),
        );
        expect(tableNames.has("tracker_artifact_reviews")).toBe(true);
      } finally {
        inspect.close();
      }
    } finally {
      await closeDbExec?.().catch(() => {});
      fs.rmSync(dbDirGreen, { recursive: true, force: true });
    }
  }, 30_000);
});

// ============================================================================
// T-F6-04 / T-F6-05: hash 防撞 + 首次回填
//
// docs/sdlc-impl-f5-f10.md §2E:
//   T-F6-05 首次回填 — "对已有 tracker_migrations 行(hash 为空)启动 → 全部
//     回填 hash,零报错零重跑".
//   T-F6-04 hash 防撞 — "单进程、零源码改动 —— 向 tracker_migrations 直接
//     UPDATE 已登记版本(如 v21)的 hash 列为任意错误值,重启同进程内的
//     runMigrations 包装层 → 启动显式抛 migration-hash-conflict: v21".
// (实现口径偏差,见 db.ts v26 条目注释:hash 落在独立的
// `tracker_migration_hashes` 表,不是 `tracker_migrations` 本身的一列——两条
// 用例改为读写这张新表,行为语义不变,仅物理位置不同。)
// These share one throwaway db/process: T-F6-05 runs first (fresh db → every
// row backfilled, no error), THEN T-F6-04 corrupts v21's hash and re-invokes
// the SAME db.ts plugin function in-process (no re-import, no source edit) to
// prove the independent verification pass — not core's version-skip — is what
// catches the divergence.
// ============================================================================

describe("T-F6-04/05: hash 防撞 + 首次回填", () => {
  let dbDir4: string;
  let dbPath4: string;

  beforeAll(async () => {
    const { closeDbExec } = await import("@agent-native/core/db");
    await closeDbExec?.().catch(() => {});
    dbDir4 = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-migration-hash-"));
    dbPath4 = path.join(dbDir4, "hash.db");
    process.env.DATABASE_URL = `file:${dbPath4}`;
  });

  afterAll(async () => {
    const { closeDbExec } = await import("@agent-native/core/db");
    await closeDbExec?.().catch(() => {});
    fs.rmSync(dbDir4, { recursive: true, force: true });
  });

  it("T-F6-05: 首次运行(全新库,hash 全空)→ 全部回填,零报错零重跑", async () => {
    const dbPluginModule = await import("../db.js");
    const trackerDbPlugin =
      dbPluginModule.default as unknown as () => Promise<void>;

    await trackerDbPlugin(); // must not throw

    const { createClient } = await import("@libsql/client");
    const inspect = createClient({ url: `file:${dbPath4}` });
    try {
      const rows = await inspect.execute(
        "SELECT version, hash FROM tracker_migration_hashes",
      );
      expect(rows.rows.length).toBeGreaterThan(0);
      for (const row of rows.rows as unknown as Array<{
        version: number;
        hash: string | null;
      }>) {
        expect(
          row.hash,
          `version ${row.version} should be backfilled`,
        ).toBeTruthy();
      }
    } finally {
      inspect.close();
    }
  }, 30_000);

  it("T-F6-04: 单进程零源码改动伪造 v21.hash 为错误值 → 重启同进程内包装层显式抛 migration-hash-conflict: v21(不静默继续)", async () => {
    const { createClient } = await import("@libsql/client");
    const inspect = createClient({ url: `file:${dbPath4}` });
    try {
      await inspect.execute({
        sql: "UPDATE tracker_migration_hashes SET hash = ? WHERE version = ?",
        args: ["bogus-hash-does-not-match-real-sql", 21],
      });
      const check = await inspect.execute({
        sql: "SELECT hash FROM tracker_migration_hashes WHERE version = ?",
        args: [21],
      });
      expect((check.rows[0] as any)?.hash).toBe(
        "bogus-hash-does-not-match-real-sql",
      );
    } finally {
      inspect.close();
    }

    const dbPluginModule = await import("../db.js");
    const trackerDbPlugin =
      dbPluginModule.default as unknown as () => Promise<void>;

    await expect(trackerDbPlugin()).rejects.toThrow(
      /migration-hash-conflict: v21/,
    );
  }, 30_000);
});
