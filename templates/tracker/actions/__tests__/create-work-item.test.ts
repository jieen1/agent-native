import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// ============================================================================
// F8: itemKey allocation authority, exercised through the REAL
// create-work-item action end-to-end (not just the allocateItemKey lib unit
// tests) — this action uses BOTH the Drizzle `getDb()` (project lookup +
// insert) AND the sequencer's raw `getDbExec()` internally, so unlike most
// other action tests in this suite, `server/db/index.js` is NOT mocked here:
// both must resolve to the SAME real SQLite file (via DATABASE_URL), same
// convention as server/plugins/__tests__/db-migration.test.ts.
//
// T-F8-01 (20-way REAL concurrency) is NOT covered here — see
// item-key-sequencer.test.ts's header and the committed
// scripts/f8-pg-verify.mts (PHASE 3) for the real-Postgres run.
// ============================================================================

let dbDir: string;
let dbPath: string;
let originalDatabaseUrl: string | undefined;

const OWNER = "owner@example.com";
const ORG_ID = "org-f8";

function asUser(fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: OWNER, orgId: ORG_ID }, fn);
}

beforeAll(() => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "create-work-item-"));
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
  await exec.execute(`CREATE TABLE IF NOT EXISTS tracker_projects (
    id TEXT PRIMARY KEY, key TEXT NOT NULL, name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '', git_remote TEXT NOT NULL DEFAULT '',
    default_branch TEXT NOT NULL DEFAULT 'main', created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, owner_email TEXT NOT NULL, org_id TEXT,
    visibility TEXT NOT NULL DEFAULT 'private'
  )`);
  await exec.execute(`CREATE TABLE IF NOT EXISTS tracker_work_items (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'requirement',
    title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open',
    priority INTEGER NOT NULL DEFAULT 0, sprint_id TEXT, item_key TEXT NOT NULL DEFAULT '',
    risk TEXT NOT NULL DEFAULT 'medium', tags TEXT NOT NULL DEFAULT '[]',
    nature TEXT NOT NULL DEFAULT '[]', owner TEXT, execution_mode TEXT NOT NULL DEFAULT 'manual',
    planned_stages TEXT NOT NULL DEFAULT '[]', current_stage_name TEXT NOT NULL DEFAULT '待办',
    branch TEXT, orchestrator_thread_id TEXT, orchestrator_task_id TEXT, orchestrator_run_id TEXT,
    orchestrator_workspace_id TEXT, dispatched_at TEXT, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, owner_email TEXT NOT NULL, org_id TEXT,
    visibility TEXT NOT NULL DEFAULT 'private', exec_state TEXT, closed_reason TEXT, closed_at TEXT,
     scale_estimate TEXT, split_parent_id TEXT
  )`);
  await exec.execute(
    `CREATE TABLE IF NOT EXISTS tracker_project_seq (project_id TEXT PRIMARY KEY, next_seq INTEGER NOT NULL)`,
  );
  await exec.execute({
    sql: `INSERT OR IGNORE INTO tracker_projects (id, key, name, created_at, updated_at, owner_email, org_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      "proj-1",
      "F8",
      "F8 Project",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
      OWNER,
      ORG_ID,
    ],
  });
  return exec;
}

afterEach(async () => {
  const { getDbExec } = await import("@agent-native/core/db");
  const exec = getDbExec();
  await exec.execute(`DELETE FROM tracker_work_items`);
  await exec.execute(`DELETE FROM tracker_project_seq`);
});

describe("create-work-item: itemKey sequencer wiring", () => {
  it("mints sequential itemKeys F8-001, F8-002, F8-003 for successive creates in the same project", async () => {
    await setup();
    const mod = await import("../create-work-item.js");
    const createWorkItem = mod.default as unknown as {
      run: (args: any) => Promise<any>;
    };

    const a = await asUser(() =>
      createWorkItem.run({ projectId: "proj-1", title: "A" }),
    );
    const b = await asUser(() =>
      createWorkItem.run({ projectId: "proj-1", title: "B" }),
    );
    const c = await asUser(() =>
      createWorkItem.run({ projectId: "proj-1", title: "C" }),
    );

    expect(a.itemKey).toBe("F8-001");
    expect(b.itemKey).toBe("F8-002");
    expect(c.itemKey).toBe("F8-003");
  });

  it("T-F8-02 (action-level): a project with 5 pre-existing legacy items (no seq row yet) mints the 6th as F8-006, not a reused number", async () => {
    const exec = await setup();
    for (let n = 1; n <= 5; n++) {
      await exec.execute({
        sql: `INSERT INTO tracker_work_items (id, project_id, item_key, title, created_at, updated_at, owner_email, org_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          `legacy-${n}`,
          "proj-1",
          `F8-${String(n).padStart(3, "0")}`,
          `legacy ${n}`,
          "2026-01-01T00:00:00Z",
          "2026-01-01T00:00:00Z",
          OWNER,
          ORG_ID,
        ],
      });
    }
    const mod = await import("../create-work-item.js");
    const createWorkItem = mod.default as unknown as {
      run: (args: any) => Promise<any>;
    };
    const next = await asUser(() =>
      createWorkItem.run({ projectId: "proj-1", title: "New" }),
    );
    expect(next.itemKey).toBe("F8-006");
  });
});
