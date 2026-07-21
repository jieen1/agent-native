import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// ============================================================================
// F8 regression: split-work-item.ts used to mint itemKeys via its own local
// `count(*)` over tracker_work_items — the exact SDLC-038 bug class
// create-work-item.ts and decompose-epic.ts were already fixed for, but this
// third writer was left behind (a dead "F8 未合并前暂沿现状计数" TODO comment
// that never got done). count(*) both races under concurrency AND undercounts
// the true next number whenever any item in the project was ever deleted, so
// it can mint a key that collides with a still-existing sibling item — this
// is the root cause behind two real work items in the same project (SDLC-033
// in project mpv5ez9njm) permanently sharing one itemKey.
//
// split-work-item.ts now routes through the SAME allocateItemKey() sequencer
// as create-work-item.ts / decompose-epic.ts, so — same convention as
// create-work-item.test.ts / decompose-epic.test.ts — `server/db/index.js` is
// NOT mocked here: both the Drizzle `getDb()` (project/parent lookup +
// insert) and the sequencer's raw `getDbExec()` must resolve to the SAME real
// SQLite file via DATABASE_URL.
//
// T-F8-01 (20-way REAL concurrency) is proven against real Postgres by
// scripts/f8-pg-verify.mts (unchanged — allocateItemKey itself was already
// atomic; this fix only removes a bypass of it). Phase 4 of that script
// additionally exercises the exact multi-allocation-per-action shape
// split-work-item uses (a for-loop of awaited allocateItemKey calls) run
// concurrently with create-work-item-shaped callers.
// ============================================================================

let dbDir: string;
let dbPath: string;
let originalDatabaseUrl: string | undefined;

const OWNER = "owner@example.com";
const ORG_ID = "org-f5";

function asUser(fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: OWNER, orgId: ORG_ID }, fn);
}

beforeAll(() => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "split-work-item-"));
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
      "F5",
      "F5 Project",
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
  await exec.execute(`DELETE FROM tracker_activities`);
  await exec.execute(`DELETE FROM tracker_links`);
  await exec.execute(`DELETE FROM tracker_work_items`);
  await exec.execute(`DELETE FROM tracker_project_seq`);
});

async function insertItem(overrides: Record<string, unknown> = {}) {
  const { getDbExec } = await import("@agent-native/core/db");
  const exec = getDbExec();
  const now = new Date().toISOString();
  const row = {
    id: `wi_${Math.random().toString(36).slice(2, 8)}`,
    projectId: "proj-1",
    type: "任务",
    title: "12 文件级 brief",
    description: "过大的 brief",
    status: "open",
    priority: 2,
    itemKey: "F5-001",
    currentStageName: "待办",
    sprintId: "sprint-1",
    execState: null,
    createdAt: now,
    updatedAt: now,
    ownerEmail: OWNER,
    orgId: ORG_ID,
    ...overrides,
  } as Record<string, unknown>;
  await exec.execute({
    sql: `INSERT INTO tracker_work_items
      (id, project_id, type, title, description, status, priority, item_key,
       current_stage_name, sprint_id, exec_state, created_at, updated_at,
       owner_email, org_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      row.id,
      row.projectId,
      row.type,
      row.title,
      row.description,
      row.status,
      row.priority,
      row.itemKey,
      row.currentStageName,
      row.sprintId,
      row.execState,
      row.createdAt,
      row.updatedAt,
      row.ownerEmail,
      row.orgId,
    ],
  });
  return row.id as string;
}

type WorkItemRow = {
  id: string;
  project_id: string;
  item_key: string;
  sprint_id: string | null;
  split_parent_id: string | null;
  status: string;
  current_stage_name: string;
};

async function childrenOf(parentId: string): Promise<WorkItemRow[]> {
  const { getDbExec } = await import("@agent-native/core/db");
  const exec = getDbExec();
  const res = await exec.execute({
    sql: `SELECT * FROM tracker_work_items WHERE split_parent_id = ?`,
    args: [parentId],
  });
  return res.rows as unknown as WorkItemRow[];
}

async function allItemKeys(projectId: string): Promise<string[]> {
  const { getDbExec } = await import("@agent-native/core/db");
  const exec = getDbExec();
  const res = await exec.execute({
    sql: `SELECT item_key FROM tracker_work_items WHERE project_id = ?`,
    args: [projectId],
  });
  return (res.rows as Array<{ item_key: string }>).map((r) => r.item_key);
}

// ============================================================================
// T-F5-05: split-work-item 建链
// ============================================================================

describe("T-F5-05: split-work-item 建链", () => {
  it("拆 3 子单,开依赖开关 — 3 新工作项同 sprint、split_parent_id=父 id、blocked-by 链 2 条;父项活动 split.performed", async () => {
    await setup();
    const mod = await import("../split-work-item.js");
    const splitWorkItem = mod.default as unknown as {
      run: (args: any) => Promise<any>;
    };
    const parentId = await insertItem();

    const result = await asUser(() =>
      splitWorkItem.run({
        workItemId: parentId,
        children: [
          { title: "子单 A", description: "第一组文件" },
          { title: "子单 B", description: "第二组文件" },
          { title: "子单 C", description: "第三组文件" },
        ],
        chainBlockedBy: true,
      }),
    );

    expect(result.children).toHaveLength(3);
    expect(result.chainedLinks).toBe(2);

    const children = await childrenOf(parentId);
    expect(children).toHaveLength(3);
    for (const c of children) {
      expect(c.sprint_id).toBe("sprint-1");
      expect(c.split_parent_id).toBe(parentId);
      expect(c.project_id).toBe("proj-1");
    }
    // itemKeys are distinct AND continue from the parent's existing F5-001 —
    // via the shared sequencer, not a local count(*).
    const keys = children.map((c) => c.item_key).sort();
    expect(new Set(keys).size).toBe(3);
    expect(keys).toEqual(["F5-002", "F5-003", "F5-004"]);

    const { getDbExec } = await import("@agent-native/core/db");
    const exec = getDbExec();
    const links = await exec.execute(
      `SELECT * FROM tracker_links WHERE link_type = 'blocked-by'`,
    );
    expect(links.rows).toHaveLength(2);

    const activities = await exec.execute({
      sql: `SELECT * FROM tracker_activities WHERE work_item_id = ? AND event_type = 'split.performed'`,
      args: [parentId],
    });
    expect(activities.rows).toHaveLength(1);
    const payload = JSON.parse(
      (activities.rows[0] as { payload: string }).payload,
    );
    expect(payload.childrenIds).toHaveLength(3);
  });

  it("拆分开关关闭时不建 blocked-by 链", async () => {
    await setup();
    const mod = await import("../split-work-item.js");
    const splitWorkItem = mod.default as unknown as {
      run: (args: any) => Promise<any>;
    };
    const parentId = await insertItem();
    const result = await asUser(() =>
      splitWorkItem.run({
        workItemId: parentId,
        children: [{ title: "子单 A" }, { title: "子单 B" }],
        chainBlockedBy: false,
      }),
    );
    expect(result.chainedLinks).toBe(0);
    const { getDbExec } = await import("@agent-native/core/db");
    const exec = getDbExec();
    const links = await exec.execute(`SELECT * FROM tracker_links`);
    expect(links.rows).toHaveLength(0);
  });

  it("父项不自动关闭 — status/currentStageName 保持不变", async () => {
    await setup();
    const mod = await import("../split-work-item.js");
    const splitWorkItem = mod.default as unknown as {
      run: (args: any) => Promise<any>;
    };
    const parentId = await insertItem({
      currentStageName: "待办",
      status: "open",
    });
    await asUser(() =>
      splitWorkItem.run({
        workItemId: parentId,
        children: [{ title: "A" }, { title: "B" }],
      }),
    );
    const { getDbExec } = await import("@agent-native/core/db");
    const exec = getDbExec();
    const res = await exec.execute({
      sql: `SELECT * FROM tracker_work_items WHERE id = ?`,
      args: [parentId],
    });
    const parent = res.rows[0] as {
      status: string;
      current_stage_name: string;
    };
    expect(parent.status).toBe("open");
    expect(parent.current_stage_name).toBe("待办");
  });

  it("schema 校验:少于 2 个子单拒绝", async () => {
    await setup();
    const mod = await import("../split-work-item.js");
    const splitWorkItem = mod.default as unknown as {
      run: (args: any) => Promise<any>;
    };
    const parentId = await insertItem();
    await expect(
      asUser(() =>
        splitWorkItem.run({
          workItemId: parentId,
          children: [{ title: "只有一个" }],
        }),
      ),
    ).rejects.toThrow();
  });
});

// ============================================================================
// T-F5-06: 已派发不可拆
// ============================================================================

describe("T-F5-06: 已派发不可拆", () => {
  it("execState='dispatched' 的项调 split → 结构化错误 already-dispatched;零新建", async () => {
    await setup();
    const mod = await import("../split-work-item.js");
    const splitWorkItem = mod.default as unknown as {
      run: (args: any) => Promise<any>;
    };
    const parentId = await insertItem({ execState: "dispatched" });

    let caught: (Error & { code?: string }) | undefined;
    try {
      await asUser(() =>
        splitWorkItem.run({
          workItemId: parentId,
          children: [{ title: "A" }, { title: "B" }],
        }),
      );
    } catch (e) {
      caught = e as Error & { code?: string };
    }
    expect(caught?.code).toBe("already-dispatched");

    const children = await childrenOf(parentId);
    expect(children).toHaveLength(0);
    const { getDbExec } = await import("@agent-native/core/db");
    const exec = getDbExec();
    const links = await exec.execute(`SELECT * FROM tracker_links`);
    expect(links.rows).toHaveLength(0);
    const activities = await exec.execute(`SELECT * FROM tracker_activities`);
    expect(activities.rows).toHaveLength(0);
  });

  it("execState=null 或 'queued' 仍可拆(未派发)", async () => {
    await setup();
    const mod = await import("../split-work-item.js");
    const splitWorkItem = mod.default as unknown as {
      run: (args: any) => Promise<any>;
    };
    const idNull = await insertItem({ execState: null });
    const resultNull = await asUser(() =>
      splitWorkItem.run({
        workItemId: idNull,
        children: [{ title: "A" }, { title: "B" }],
      }),
    );
    expect(resultNull.children).toHaveLength(2);

    const idQueued = await insertItem({ execState: "queued" });
    const resultQueued = await asUser(() =>
      splitWorkItem.run({
        workItemId: idQueued,
        children: [{ title: "A" }, { title: "B" }],
      }),
    );
    expect(resultQueued.children).toHaveLength(2);
  });

  it("execState='running'/'returned' 同样拒绝(不只 'dispatched')", async () => {
    await setup();
    const mod = await import("../split-work-item.js");
    const splitWorkItem = mod.default as unknown as {
      run: (args: any) => Promise<any>;
    };
    for (const execState of ["running", "returned"]) {
      const parentId = await insertItem({ execState });
      let caught: (Error & { code?: string }) | undefined;
      try {
        await asUser(() =>
          splitWorkItem.run({
            workItemId: parentId,
            children: [{ title: "A" }, { title: "B" }],
          }),
        );
      } catch (e) {
        caught = e as Error & { code?: string };
      }
      expect(caught?.code).toBe("already-dispatched");
    }
  });
});

// ============================================================================
// F8 regression: split-work-item itemKey sequencer wiring
// ============================================================================

describe("F8 regression: split-work-item itemKey sequencer wiring", () => {
  it("children continue sequentially from an existing legacy project (no seq row yet) via the shared sequencer, not a local count(*)", async () => {
    const exec = await setup();
    // 5 legacy items, no tracker_project_seq row yet (pre-F8-shaped data).
    for (let n = 1; n <= 5; n++) {
      await exec.execute({
        sql: `INSERT INTO tracker_work_items (id, project_id, item_key, title, created_at, updated_at, owner_email, org_id, current_stage_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          `legacy-${n}`,
          "proj-1",
          `F5-${String(n).padStart(3, "0")}`,
          `legacy ${n}`,
          "2026-01-01T00:00:00Z",
          "2026-01-01T00:00:00Z",
          OWNER,
          ORG_ID,
          "待办",
        ],
      });
    }
    const mod = await import("../split-work-item.js");
    const splitWorkItem = mod.default as unknown as {
      run: (args: any) => Promise<any>;
    };
    const result = await asUser(() =>
      splitWorkItem.run({
        workItemId: "legacy-1",
        children: [{ title: "Child A" }, { title: "Child B" }],
      }),
    );
    const keys = result.children.map((c: any) => c.itemKey);
    expect(keys).toEqual(["F5-006", "F5-007"]);
  });

  it("REGRESSION (SDLC-033 root cause): a prior deletion makes count(*) undercount the true next number — splitting must not mint a key that collides with a still-existing sibling item", async () => {
    await setup();
    const createMod = await import("../create-work-item.js");
    const createWorkItem = createMod.default as unknown as {
      run: (args: any) => Promise<any>;
    };
    const splitMod = await import("../split-work-item.js");
    const splitWorkItem = splitMod.default as unknown as {
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
    expect([a.itemKey, b.itemKey, c.itemKey]).toEqual([
      "F5-001",
      "F5-002",
      "F5-003",
    ]);

    // A human deletes B — a completely ordinary, real operation
    // (delete-work-item). tracker_project_seq (next_seq=3) is untouched by
    // this, but a naive count(*) over the project now reads 2, undercounting
    // the true highest issued number (3).
    const { getDbExec } = await import("@agent-native/core/db");
    const exec = getDbExec();
    await exec.execute({
      sql: `DELETE FROM tracker_work_items WHERE id = ?`,
      args: [b.id],
    });

    const result = await asUser(() =>
      splitWorkItem.run({
        workItemId: a.id,
        children: [{ title: "Child X" }, { title: "Child Y" }],
      }),
    );
    const childKeys = result.children.map((ch: any) => ch.itemKey);

    // Pre-fix, count(*)+1 => F5-003, which is C's existing itemKey — a live
    // collision. Post-fix, the shared sequencer continues from 4.
    expect(childKeys).toEqual(["F5-004", "F5-005"]);
    expect(childKeys).not.toContain(c.itemKey);

    const keys = await allItemKeys("proj-1");
    expect(new Set(keys).size).toBe(keys.length); // no duplicates anywhere
  });

  it("create-work-item interleaved with split-work-item never collides (shared sequencer)", async () => {
    const exec = await setup();
    await exec.execute({
      sql: `INSERT INTO tracker_work_items (id, project_id, item_key, title, created_at, updated_at, owner_email, org_id, current_stage_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        "parent-1",
        "proj-1",
        "F5-001",
        "Parent",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
        OWNER,
        ORG_ID,
        "待办",
      ],
    });

    const createMod = await import("../create-work-item.js");
    const createWorkItem = createMod.default as unknown as {
      run: (args: any) => Promise<any>;
    };
    const splitMod = await import("../split-work-item.js");
    const splitWorkItem = splitMod.default as unknown as {
      run: (args: any) => Promise<any>;
    };

    const created = await asUser(() =>
      createWorkItem.run({ projectId: "proj-1", title: "Standalone" }),
    );
    const split = await asUser(() =>
      splitWorkItem.run({
        workItemId: "parent-1",
        children: [{ title: "Child A" }, { title: "Child B" }],
      }),
    );

    const allKeys = [
      created.itemKey,
      ...split.children.map((c: any) => c.itemKey),
    ];
    expect(new Set(allKeys).size).toBe(allKeys.length);
    expect(created.itemKey).toBe("F5-002");
    expect(split.children.map((c: any) => c.itemKey)).toEqual([
      "F5-003",
      "F5-004",
    ]);
  });

  it("two different projects splitting concurrently have fully independent sequences", async () => {
    const exec = await setup();
    await exec.execute({
      sql: `INSERT INTO tracker_projects (id, key, name, created_at, updated_at, owner_email, org_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        "proj-2",
        "OTHER",
        "Other Project",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
        OWNER,
        ORG_ID,
      ],
    });
    const parentA = await insertItem({
      projectId: "proj-1",
      itemKey: "F5-001",
    });
    await exec.execute({
      sql: `INSERT INTO tracker_work_items (id, project_id, item_key, title, created_at, updated_at, owner_email, org_id, current_stage_name, sprint_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        "parent-b",
        "proj-2",
        "OTHER-001",
        "Parent B",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
        OWNER,
        ORG_ID,
        "待办",
        null,
      ],
    });

    const mod = await import("../split-work-item.js");
    const splitWorkItem = mod.default as unknown as {
      run: (args: any) => Promise<any>;
    };

    const [resultA, resultB] = await Promise.all([
      asUser(() =>
        splitWorkItem.run({
          workItemId: parentA,
          children: [{ title: "A-Child-1" }, { title: "A-Child-2" }],
        }),
      ),
      asUser(() =>
        splitWorkItem.run({
          workItemId: "parent-b",
          children: [{ title: "B-Child-1" }, { title: "B-Child-2" }],
        }),
      ),
    ]);

    expect(resultA.children.map((c: any) => c.itemKey)).toEqual([
      "F5-002",
      "F5-003",
    ]);
    expect(resultB.children.map((c: any) => c.itemKey)).toEqual([
      "OTHER-002",
      "OTHER-003",
    ]);
  });
});
