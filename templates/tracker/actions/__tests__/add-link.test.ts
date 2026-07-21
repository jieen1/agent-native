import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { createClient, type Client } from "@libsql/client";
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
let addLink: AnyAction;

const OWNER_A = "alice@example.com";
const OWNER_B = "mallory@example.com";
const ORG_A = "org-a";
const ORG_B = "org-b";

function asUser(email: string, orgId: string, fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: email, orgId }, fn);
}

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-link-"));
  client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
  db = drizzle(client, { schema: trackerSchema });

  await client.executeMultiple(`
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
      owner_email TEXT NOT NULL DEFAULT 'local@localhost',
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

  const mod = await import("../add-link.js");
  addLink = mod.default as unknown as AnyAction;
}, 30_000);

afterAll(() => {
  client?.close();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

async function insertItem(
  id: string,
  ownerEmail: string,
  orgId: string,
  projectId = "proj-a",
): Promise<string> {
  const now = new Date().toISOString();
  await db.insert(trackerSchema.workItems).values({
    id,
    projectId,
    type: "task",
    title: `Item ${id}`,
    description: "",
    status: "open",
    priority: 1,
    createdAt: now,
    updatedAt: now,
    ownerEmail,
    orgId,
    itemKey: id.toUpperCase(),
    currentStageName: "待办",
  });
  return id;
}

async function fetchLinks() {
  return db.select().from(trackerSchema.links);
}

async function fetchActivities() {
  return db.select().from(trackerSchema.activities);
}

beforeEach(async () => {
  await client.executeMultiple(`
    DELETE FROM tracker_activities;
    DELETE FROM tracker_links;
    DELETE FROM tracker_work_items;
  `);
});

// ============================================================================
// mcjtb11tzu: add-link 的 toItemId 缺 owner/org 范围限定,可制造跨租户
// blocked-by 链接(SDLC-100 攻击链的入口)。toItemId 现在必须与 fromItemId
// 走同一条 ownerScope,跨租户目标一律拒绝,且不残留 link/activity 行。
// ============================================================================

describe("add-link cross-tenant toItemId 边界", () => {
  it("跨租户:A 的 fromItemId + B 的 toItemId → 拒绝(not accessible),不产生 link/activity 行", async () => {
    await insertItem("wi_a_from", OWNER_A, ORG_A);
    await insertItem("wi_b_to", OWNER_B, ORG_B);

    await expect(
      asUser(OWNER_A, ORG_A, () =>
        addLink.run({
          fromItemId: "wi_a_from",
          toItemId: "wi_b_to",
          linkType: "blocked-by",
        }),
      ),
    ).rejects.toThrow(/not found|not accessible/i);

    expect(await fetchLinks()).toHaveLength(0);
    expect(await fetchActivities()).toHaveLength(0);
  });

  it("跨租户:反方向仍拒绝 —— B 的 fromItemId + A 的 toItemId 也不可用(边界对称)", async () => {
    await insertItem("wi_b_from", OWNER_B, ORG_B);
    await insertItem("wi_a_to", OWNER_A, ORG_A);

    await expect(
      asUser(OWNER_B, ORG_B, () =>
        addLink.run({
          fromItemId: "wi_b_from",
          toItemId: "wi_a_to",
          linkType: "blocked-by",
        }),
      ),
    ).rejects.toThrow(/not found|not accessible/i);

    expect(await fetchLinks()).toHaveLength(0);
  });

  it("跨租户目标不存在时同样拒绝(与已存在但他租户拥有的目标报同一类错误)", async () => {
    await insertItem("wi_a_from2", OWNER_A, ORG_A);

    await expect(
      asUser(OWNER_A, ORG_A, () =>
        addLink.run({
          fromItemId: "wi_a_from2",
          toItemId: "does-not-exist",
          linkType: "relates-to",
        }),
      ),
    ).rejects.toThrow(/not found|not accessible/i);

    expect(await fetchLinks()).toHaveLength(0);
  });

  it("同租户,跨项目仍然放行 —— ownerScope 只按 owner/org 限定,不按 project 限定", async () => {
    await insertItem("wi_a_p1", OWNER_A, ORG_A, "proj-1");
    await insertItem("wi_a_p2", OWNER_A, ORG_A, "proj-2");

    const result = await asUser(OWNER_A, ORG_A, () =>
      addLink.run({
        fromItemId: "wi_a_p1",
        toItemId: "wi_a_p2",
        linkType: "relates-to",
      }),
    );

    expect(result.fromItemId).toBe("wi_a_p1");
    expect(result.toItemId).toBe("wi_a_p2");

    const links = await fetchLinks();
    expect(links).toHaveLength(1);
    expect(links[0]!.linkType).toBe("relates-to");

    const activities = await fetchActivities();
    expect(activities).toHaveLength(1);
    expect(activities[0]!.eventType).toBe("link");
  });

  it("同租户,同一 org 下不同 owner_email 仍然放行(org 共享覆盖 owner 差异)", async () => {
    await insertItem("wi_org_from", "someone@example.com", ORG_A);
    await insertItem("wi_org_to", "someone-else@example.com", ORG_A);

    const result = await asUser(OWNER_A, ORG_A, () =>
      addLink.run({
        fromItemId: "wi_org_from",
        toItemId: "wi_org_to",
        linkType: "depends-on",
      }),
    );

    expect(result.fromItemId).toBe("wi_org_from");
    expect(result.toItemId).toBe("wi_org_to");
    expect(await fetchLinks()).toHaveLength(1);
  });

  it("重复链接仍被拒绝(既有去重行为不回归)", async () => {
    await insertItem("wi_dup_from", OWNER_A, ORG_A);
    await insertItem("wi_dup_to", OWNER_A, ORG_A);

    await asUser(OWNER_A, ORG_A, () =>
      addLink.run({
        fromItemId: "wi_dup_from",
        toItemId: "wi_dup_to",
        linkType: "blocks",
      }),
    );

    await expect(
      asUser(OWNER_A, ORG_A, () =>
        addLink.run({
          fromItemId: "wi_dup_from",
          toItemId: "wi_dup_to",
          linkType: "blocks",
        }),
      ),
    ).rejects.toThrow(/already exists/i);

    expect(await fetchLinks()).toHaveLength(1);
  });
});
