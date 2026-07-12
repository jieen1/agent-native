import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// ============================================================================
// F8: decompose-epic.ts's itemKey generation now routes through the SAME
// project-level sequencer as create-work-item.ts (server/lib/item-key-
// sequencer.ts) instead of its own independent count(*) — pre-F8, epic
// decomposition and create-work-item each ran their OWN count(*), a second
// uncoordinated writer that could mint the same itemKey twice even with
// create-work-item's own count(*) bug fixed in isolation. Same DATABASE_URL-
// pointing convention as create-work-item.test.ts (this action also uses
// both getDb() and the sequencer's getDbExec() internally).
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
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "decompose-epic-"));
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
  await exec.execute(`CREATE TABLE IF NOT EXISTS tracker_links (
    id TEXT PRIMARY KEY, from_item_id TEXT NOT NULL, to_item_id TEXT NOT NULL,
    link_type TEXT NOT NULL DEFAULT 'relates_to', created_at TEXT NOT NULL,
    owner_email TEXT NOT NULL, org_id TEXT, visibility TEXT NOT NULL DEFAULT 'private'
  )`);
  await exec.execute(`CREATE TABLE IF NOT EXISTS tracker_activities (
    id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, actor_kind TEXT DEFAULT 'agent',
    actor_name TEXT DEFAULT '', event_type TEXT NOT NULL, payload TEXT DEFAULT '{}',
    created_at TEXT NOT NULL, owner_email TEXT, org_id TEXT,
    visibility TEXT NOT NULL DEFAULT 'private'
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
  await exec.execute({
    sql: `INSERT OR IGNORE INTO tracker_work_items (id, project_id, type, title, item_key, created_at, updated_at, owner_email, org_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      "epic-1",
      "proj-1",
      "集合",
      "Epic",
      "F8-001",
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
  await exec.execute(`DELETE FROM tracker_work_items WHERE id != 'epic-1'`);
  await exec.execute(`DELETE FROM tracker_links`);
  await exec.execute(`DELETE FROM tracker_activities`);
  await exec.execute(`DELETE FROM tracker_project_seq`);
});

describe("decompose-epic: itemKey sequencer routing", () => {
  it("children get sequential itemKeys continuing from the epic's own number, via the shared sequencer (not a local count(*))", async () => {
    await setup();
    const mod = await import("../decompose-epic.js");
    const decomposeEpic = mod.default as unknown as {
      run: (args: any) => Promise<any>;
    };

    const result = await asUser(() =>
      decomposeEpic.run({
        epicId: "epic-1",
        children: [
          { title: "Child A" },
          { title: "Child B" },
          { title: "Child C" },
        ],
      }),
    );

    const keys = result.children.map((c: any) => c.itemKey);
    // epic-1 already holds F8-001 — children continue from 002.
    expect(keys).toEqual(["F8-002", "F8-003", "F8-004"]);
  });

  it("a create-work-item call interleaved with decompose-epic never collides (shared sequencer, not two independent counters)", async () => {
    await setup();
    const createMod = await import("../create-work-item.js");
    const createWorkItem = createMod.default as unknown as {
      run: (args: any) => Promise<any>;
    };
    const decomposeMod = await import("../decompose-epic.js");
    const decomposeEpic = decomposeMod.default as unknown as {
      run: (args: any) => Promise<any>;
    };

    const created = await asUser(() =>
      createWorkItem.run({ projectId: "proj-1", title: "Standalone" }),
    );
    const decomposed = await asUser(() =>
      decomposeEpic.run({ epicId: "epic-1", children: [{ title: "Child A" }] }),
    );

    const allKeys = [
      created.itemKey,
      ...decomposed.children.map((c: any) => c.itemKey),
    ];
    expect(new Set(allKeys).size).toBe(allKeys.length); // no duplicates
    expect(created.itemKey).toBe("F8-002");
    expect(decomposed.children[0].itemKey).toBe("F8-003");
  });
});
