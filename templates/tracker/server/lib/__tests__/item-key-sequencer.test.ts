import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// ============================================================================
// F8: itemKey allocation authority (server/lib/item-key-sequencer.ts).
//
// `allocateItemKey` calls the framework's process-wide `getDbExec()` singleton
// internally (not a passed-in db handle — it needs raw SQL with dialect
// branching Drizzle doesn't expose), so — same convention as
// server/plugins/__tests__/db-migration.test.ts — this file points
// `process.env.DATABASE_URL` at an isolated throwaway SQLite file BEFORE the
// first call, never the template's real local dev DB.
//
// SCOPE OF THIS COMMITTED FILE: SQLite sequencer BEHAVIOR only — T-F8-02
// (existing-project takeover from legacy itemKeys), gap/out-of-order seeding,
// blank-key handling, and per-project independence. These are dialect-neutral
// and SQLite proves them faithfully.
//
// This file DOES NOT (and cannot) cover T-F8-01's "20-way REAL concurrency,
// zero duplicate itemKeys": SQLite/libsql's single-writer lock serializes
// "concurrent" calls trivially, so 20 "parallel" allocateItemKey calls would
// pass even against a broken (non-atomic) allocator — the exact false-green
// the B5 lesson warns about. The atomicity guarantee lives in the Postgres
// path's `UPDATE ... SET next_seq = next_seq + 1 RETURNING next_seq` (row-
// level lock), and reading back the RETURNING value only exercises on real
// Postgres. That proof is DEPLOYMENT-WINDOW EVIDENCE, reproducible via the
// committed standalone script scripts/f8-pg-verify.mts (run against a
// throwaway Postgres container — see that file's header for the exact
// command). It is intentionally NOT a vitest suite, because a green run here
// under SQLite must never be mistaken for concurrency evidence.
// ============================================================================

let dbDir: string;
let dbPath: string;
let originalDatabaseUrl: string | undefined;

beforeAll(() => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "item-key-sequencer-"));
  dbPath = path.join(dbDir, "test.db");
  originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = `file:${dbPath}`;
});

afterAll(async () => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  const { closeDbExec } = await import("@agent-native/core/db");
  await closeDbExec?.().catch(() => {});
  fs.rmSync(dbDir, { recursive: true, force: true });
});

async function setup() {
  const { getDbExec } = await import("@agent-native/core/db");
  const exec = getDbExec();
  await exec.execute(
    `CREATE TABLE IF NOT EXISTS tracker_project_seq (project_id TEXT PRIMARY KEY, next_seq INTEGER NOT NULL)`,
  );
  await exec.execute(
    `CREATE TABLE IF NOT EXISTS tracker_work_items (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, item_key TEXT NOT NULL DEFAULT '')`,
  );
  return exec;
}

afterEach(async () => {
  const { getDbExec } = await import("@agent-native/core/db");
  const exec = getDbExec();
  await exec.execute(`DELETE FROM tracker_project_seq`);
  await exec.execute(`DELETE FROM tracker_work_items`);
});

describe("allocateItemKey", () => {
  it("a brand-new project starts at 001 and increments sequentially (no gaps)", async () => {
    await setup();
    const { allocateItemKey } = await import("../item-key-sequencer.js");

    const a = await allocateItemKey("proj-new", "NEW");
    const b = await allocateItemKey("proj-new", "NEW");
    const c = await allocateItemKey("proj-new", "NEW");

    expect(a).toBe("NEW-001");
    expect(b).toBe("NEW-002");
    expect(c).toBe("NEW-003");
  });

  // ==========================================================================
  // T-F8-02: 序列器接管存量 — 对已有 N 单的 project 建新单 -> 新 itemKey=N+1,
  // 不回头复用. Exercises the lazy per-project seed path (no
  // tracker_project_seq row yet, but tracker_work_items already has items —
  // simulating either a pre-F8 project or one created between the v27
  // migration and this call).
  // ==========================================================================
  it("T-F8-02: an existing project with N legacy items (no seq row yet) seeds at N and the first new item is N+1 — never reuses a number", async () => {
    const exec = await setup();
    // Simulate 38 legacy items for this project, numbered 1..38 (padded, as
    // create-work-item historically formatted them), with NO
    // tracker_project_seq row — this is the "old project pre-dating the
    // sequencer" case.
    for (let n = 1; n <= 38; n++) {
      await exec.execute({
        sql: `INSERT INTO tracker_work_items (id, project_id, item_key) VALUES (?, ?, ?)`,
        args: [
          `legacy-${n}`,
          "proj-legacy",
          `LEG-${String(n).padStart(3, "0")}`,
        ],
      });
    }

    const { allocateItemKey } = await import("../item-key-sequencer.js");
    const next = await allocateItemKey("proj-legacy", "LEG");
    expect(next).toBe("LEG-039");

    // A second call must not re-derive from tracker_work_items again (that
    // would still give 39, coincidentally correct once, but WRONG on a
    // third call — the seq row must now be authoritative, not re-scanned).
    const third = await allocateItemKey("proj-legacy", "LEG");
    expect(third).toBe("LEG-040");
  });

  it("does not reuse a number even when the legacy itemKeys have gaps or out-of-order numbers", async () => {
    const exec = await setup();
    for (const key of ["GAP-001", "GAP-005", "GAP-003"]) {
      await exec.execute({
        sql: `INSERT INTO tracker_work_items (id, project_id, item_key) VALUES (?, ?, ?)`,
        args: [key, "proj-gap", key],
      });
    }
    const { allocateItemKey } = await import("../item-key-sequencer.js");
    const next = await allocateItemKey("proj-gap", "GAP");
    // Max existing is 5 (not count=3) -> next must be 6, not 4.
    expect(next).toBe("GAP-006");
  });

  it("blank/malformed legacy itemKeys don't corrupt the seed (treated as 0)", async () => {
    const exec = await setup();
    await exec.execute({
      sql: `INSERT INTO tracker_work_items (id, project_id, item_key) VALUES (?, ?, ?)`,
      args: ["blank-1", "proj-blank", ""],
    });
    const { allocateItemKey } = await import("../item-key-sequencer.js");
    const next = await allocateItemKey("proj-blank", "BLK");
    expect(next).toBe("BLK-001");
  });

  it("two different projects have fully independent sequences", async () => {
    await setup();
    const { allocateItemKey } = await import("../item-key-sequencer.js");
    const a1 = await allocateItemKey("proj-a", "A");
    const b1 = await allocateItemKey("proj-b", "B");
    const a2 = await allocateItemKey("proj-a", "A");
    expect(a1).toBe("A-001");
    expect(b1).toBe("B-001");
    expect(a2).toBe("A-002");
  });
});

describe("maxNumericSuffix", () => {
  it("extracts the highest trailing numeric suffix across a batch", async () => {
    const { maxNumericSuffix } = await import("../item-key-sequencer.js");
    expect(maxNumericSuffix(["PAY-001", "PAY-014", "PAY-007"])).toBe(14);
  });

  it("ignores blank/null/unparseable entries (contributes 0)", async () => {
    const { maxNumericSuffix } = await import("../item-key-sequencer.js");
    expect(maxNumericSuffix([null, undefined, "", "NOKEY"])).toBe(0);
  });

  it("returns 0 for an empty list", async () => {
    const { maxNumericSuffix } = await import("../item-key-sequencer.js");
    expect(maxNumericSuffix([])).toBe(0);
  });
});
