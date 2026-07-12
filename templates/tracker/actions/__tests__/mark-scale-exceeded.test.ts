import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { createClient, type Client } from "@libsql/client";
import { eq } from "drizzle-orm";
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
let markScaleExceeded: AnyAction;

const OWNER_A = "alice@example.com";
const OWNER_B = "mallory@example.com";
const ORG_A = "org-a";
const ORG_B = "org-b";

function asUser(email: string, orgId: string, fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: email, orgId }, fn);
}

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "mark-scale-exceeded-"));
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

  const mod = await import("../mark-scale-exceeded.js");
  markScaleExceeded = mod.default as unknown as AnyAction;
}, 30_000);

afterAll(() => {
  client?.close();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.executeMultiple(`
    DELETE FROM tracker_activities;
    DELETE FROM tracker_work_items;
  `);
  // Item owned by tenant A.
  await db.insert(trackerSchema.workItems).values({
    id: "wi_a",
    projectId: "proj-a",
    type: "task",
    title: "A 的工作项",
    description: "requirement",
    status: "open",
    priority: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ownerEmail: OWNER_A,
    orgId: ORG_A,
    itemKey: "A-1",
    currentStageName: "待办",
  });
});

async function fetchItem(id: string) {
  return (
    await db
      .select()
      .from(trackerSchema.workItems)
      .where(eq(trackerSchema.workItems.id, id))
  )[0];
}

// ============================================================================
// CR-2 (评审必补): mark-scale-exceeded 必须 ownerScope —— 跨租户传他人
// workItemId 应被拒(不可跨租户读 + 翻转 scale_estimate + 写冠名活动)。
// ============================================================================

describe("CR-2: mark-scale-exceeded ownerScope 边界", () => {
  it("跨租户:B 传 A 的 workItemId → 拒绝(not accessible),A 的行与活动纹丝不动", async () => {
    await expect(
      asUser(OWNER_B, ORG_B, () =>
        markScaleExceeded.run({ workItemId: "wi_a", exhaustionCount: 3 }),
      ),
    ).rejects.toThrow(/not accessible|not found/i);

    // A's scale_estimate NOT flipped.
    const row = await fetchItem("wi_a");
    expect((row as any).scaleEstimate).toBeNull();
    // No cross-tenant activity row written.
    const activities = await db.select().from(trackerSchema.activities);
    expect(activities).toHaveLength(0);
  });

  it("同租户:A 标记自己的项 → 成功翻转 scale_estimate 为 split-required + 写活动", async () => {
    const result = await asUser(OWNER_A, ORG_A, () =>
      markScaleExceeded.run({ workItemId: "wi_a", exhaustionCount: 2 }),
    );
    expect(result.marked).toBe(true);
    expect(result.scaleEstimate.verdict).toBe("split-required");

    const row = await fetchItem("wi_a");
    const parsed = JSON.parse((row as any).scaleEstimate);
    expect(parsed.verdict).toBe("split-required");
    expect(parsed.signals).toContain("runtime:budget-exhausted");

    const activities = await db
      .select()
      .from(trackerSchema.activities)
      .where(
        eq(trackerSchema.activities.eventType, "scale.exceeded-at-runtime"),
      );
    expect(activities).toHaveLength(1);
  });

  it("未达阈值(exhaustionCount=1)→ 不翻转、不写活动(marked=false)", async () => {
    const result = await asUser(OWNER_A, ORG_A, () =>
      markScaleExceeded.run({ workItemId: "wi_a", exhaustionCount: 1 }),
    );
    expect(result.marked).toBe(false);

    const row = await fetchItem("wi_a");
    expect((row as any).scaleEstimate).toBeNull();
    const activities = await db.select().from(trackerSchema.activities);
    expect(activities).toHaveLength(0);
  });
});
