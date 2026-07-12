import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { createClient, type Client } from "@libsql/client";
import { and, eq } from "drizzle-orm";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as trackerSchema from "../../server/db/schema.js";

let client: Client;
let db: LibSQLDatabase<typeof trackerSchema>;
let dbDir: string;

vi.mock("../../server/db/index.js", () => ({
  getDb: () => db,
  schema: trackerSchema,
}));

type AnyAction = { run: (args: any) => Promise<any> };
let splitWorkItem: AnyAction;

const OWNER = "owner@example.com";
const ORG_ID = "org-f5";

function asUser(fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: OWNER, orgId: ORG_ID }, fn);
}

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "split-work-item-"));
  client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
  db = drizzle(client, { schema: trackerSchema });

  await client.executeMultiple(`
    CREATE TABLE tracker_projects (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      git_remote TEXT NOT NULL DEFAULT '',
      default_branch TEXT NOT NULL DEFAULT 'main',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      stage_gate_config TEXT NOT NULL DEFAULT '{}',
      owner_email TEXT NOT NULL,
      org_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
    );
    CREATE TABLE tracker_work_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'requirement',
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      priority INTEGER NOT NULL DEFAULT 0,
      orchestrator_thread_id TEXT,
      orchestrator_task_id TEXT,
      orchestrator_run_id TEXT,
      orchestrator_workspace_id TEXT,
      dispatched_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      owner_email TEXT NOT NULL,
      org_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private',
      sprint_id TEXT,
      item_key TEXT NOT NULL DEFAULT '',
      risk TEXT NOT NULL DEFAULT 'medium',
      tags TEXT NOT NULL DEFAULT '[]',
      execution_mode TEXT NOT NULL DEFAULT 'manual',
      planned_stages TEXT NOT NULL DEFAULT '[]',
      current_stage_name TEXT NOT NULL DEFAULT '待办',
      branch TEXT,
      owner TEXT,
      nature TEXT NOT NULL DEFAULT '[]',
      exec_state TEXT,
      closed_reason TEXT,
      closed_at TEXT,
      scale_estimate TEXT,
      split_parent_id TEXT
    );
    CREATE TABLE tracker_links (
      id TEXT PRIMARY KEY,
      from_item_id TEXT NOT NULL,
      to_item_id TEXT NOT NULL,
      link_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      owner_email TEXT NOT NULL,
      org_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
    );
    CREATE TABLE tracker_activities (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      actor_kind TEXT DEFAULT 'agent',
      actor_name TEXT DEFAULT '智能体',
      event_type TEXT NOT NULL,
      payload TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      owner_email TEXT,
      org_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
    );
  `);

  const mod = await import("../split-work-item.js");
  splitWorkItem = mod.default as unknown as AnyAction;
}, 30_000);

afterAll(() => {
  client?.close();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.executeMultiple(`
    DELETE FROM tracker_activities;
    DELETE FROM tracker_links;
    DELETE FROM tracker_work_items;
    DELETE FROM tracker_projects;
  `);
  await db.insert(trackerSchema.projects).values({
    id: "proj-1",
    key: "F5",
    name: "F5 Project",
    description: "",
    gitRemote: "git@example.com:f5.git",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ownerEmail: OWNER,
    orgId: ORG_ID,
  });
});

async function insertItem(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  const id =
    (overrides.id as string) ?? `wi_${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(trackerSchema.workItems).values({
    id,
    projectId: "proj-1",
    type: "任务",
    title: "12 文件级 brief",
    description: "过大的 brief",
    status: "open",
    priority: 2,
    createdAt: now,
    updatedAt: now,
    ownerEmail: OWNER,
    orgId: ORG_ID,
    itemKey: "F5-1",
    currentStageName: "待办",
    sprintId: "sprint-1",
    ...overrides,
  });
  return id;
}

async function childrenOf(parentId: string) {
  return db
    .select()
    .from(trackerSchema.workItems)
    .where(eq(trackerSchema.workItems.splitParentId, parentId));
}

// ============================================================================
// T-F5-05: split-work-item 建链
// ============================================================================

describe("T-F5-05: split-work-item 建链", () => {
  it("拆 3 子单,开依赖开关 — 3 新工作项同 sprint、split_parent_id=父 id、blocked-by 链 2 条;父项活动 split.performed", async () => {
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
      expect(c.sprintId).toBe("sprint-1");
      expect(c.splitParentId).toBe(parentId);
      expect(c.projectId).toBe("proj-1");
    }
    // itemKeys are distinct and sequential.
    const keys = children.map((c) => c.itemKey).sort();
    expect(new Set(keys).size).toBe(3);

    const links = await db
      .select()
      .from(trackerSchema.links)
      .where(eq(trackerSchema.links.linkType, "blocked-by"));
    expect(links).toHaveLength(2);
    // children[1] blocked-by children[0]; children[2] blocked-by children[1].
    const byId = new Map(result.children.map((c: any) => [c.id, c]));
    expect(byId.has(links[0]!.fromItemId)).toBe(true);

    const activities = await db
      .select()
      .from(trackerSchema.activities)
      .where(
        and(
          eq(trackerSchema.activities.workItemId, parentId),
          eq(trackerSchema.activities.eventType, "split.performed"),
        ),
      );
    expect(activities).toHaveLength(1);
    const payload = JSON.parse(activities[0]!.payload);
    expect(payload.childrenIds).toHaveLength(3);
  });

  it("拆分开关关闭时不建 blocked-by 链", async () => {
    const parentId = await insertItem();
    const result = await asUser(() =>
      splitWorkItem.run({
        workItemId: parentId,
        children: [{ title: "子单 A" }, { title: "子单 B" }],
        chainBlockedBy: false,
      }),
    );
    expect(result.chainedLinks).toBe(0);
    const links = await db.select().from(trackerSchema.links);
    expect(links).toHaveLength(0);
  });

  it("父项不自动关闭 — status/currentStageName 保持不变", async () => {
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
    const parent = (
      await db
        .select()
        .from(trackerSchema.workItems)
        .where(eq(trackerSchema.workItems.id, parentId))
    )[0];
    expect(parent!.status).toBe("open");
    expect(parent!.currentStageName).toBe("待办");
  });

  it("schema 校验:少于 2 个子单拒绝", async () => {
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
    const links = await db.select().from(trackerSchema.links);
    expect(links).toHaveLength(0);
    const activities = await db.select().from(trackerSchema.activities);
    expect(activities).toHaveLength(0);
  });

  it("execState=null 或 'queued' 仍可拆(未派发)", async () => {
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
