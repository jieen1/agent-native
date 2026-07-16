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
let enqueueWorkItem: AnyAction;

const OWNER = "owner@example.com";
const ORG_ID = "org-enqueue";

function asUser(fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: OWNER, orgId: ORG_ID }, fn);
}

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "enqueue-work-item-"));
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
    CREATE TABLE tracker_exec_queue (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL UNIQUE,
      priority INTEGER DEFAULT 0,
      status TEXT DEFAULT 'queued',
      current_stage TEXT DEFAULT '',
      enqueued_at TEXT NOT NULL,
      started_at TEXT,
      blocked_by TEXT DEFAULT '[]',
      position INTEGER,
      waiting_on TEXT DEFAULT '{}',
      health_check_log TEXT,
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
    CREATE TABLE tracker_stages (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      stage_name TEXT NOT NULL,
      stage_status TEXT DEFAULT '待执行',
      delivery_items TEXT DEFAULT '[]',
      workflow_run_ref TEXT,
      verdict TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      owner_email TEXT NOT NULL,
      org_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
    );
  `);

  const mod = await import("../enqueue-work-item.js");
  enqueueWorkItem = mod.default as unknown as AnyAction;
}, 30_000);

afterAll(() => {
  client?.close();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.executeMultiple(`
    DELETE FROM tracker_activities;
    DELETE FROM tracker_stages;
    DELETE FROM tracker_work_items;
    DELETE FROM tracker_exec_queue;
    DELETE FROM tracker_links;
  `);
  vi.restoreAllMocks();
});

async function insertItem(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  const id =
    (overrides.id as string) ?? `wi_${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(trackerSchema.workItems).values({
    id,
    projectId: "proj-1",
    type: "task",
    title: "Test item",
    status: "open",
    priority: 1,
    createdAt: now,
    updatedAt: now,
    ownerEmail: OWNER,
    orgId: ORG_ID,
    itemKey: "F3-1",
    currentStageName: "待办",
    ...overrides,
  });
  return id;
}

async function fetchQueueRow(workItemId: string) {
  return (
    await db
      .select()
      .from(trackerSchema.execQueue)
      .where(eq(trackerSchema.execQueue.workItemId, workItemId))
  )[0];
}

describe("enqueue-work-item: waitingOn (v28)", () => {
  it("a ready item (no dependencies) is queued with waitingOn='{}'", async () => {
    const id = await insertItem();
    const result = await asUser(() => enqueueWorkItem.run({ workItemId: id }));
    expect(result.status).toBe("queued");
    expect(result.waitingOn).toBe("{}");

    const row = await fetchQueueRow(id);
    expect(row.status).toBe("queued");
    expect(row.waitingOn).toBe("{}");
  });

  it("a dependency-blocked item is enqueued blocked with waitingOn={type:'dependency',...} alongside legacy blockedBy", async () => {
    const upstream = await insertItem({ currentStageName: "实施" });
    const downstream = await insertItem();
    const now = new Date().toISOString();
    await db.insert(trackerSchema.links).values({
      id: "link-1",
      fromItemId: downstream,
      toItemId: upstream,
      linkType: "blocked-by",
      createdAt: now,
      ownerEmail: OWNER,
      orgId: ORG_ID,
    });
    // Upstream's 实施 stage not yet complete — dependency gate stays unready.
    await db.insert(trackerSchema.stages).values({
      id: "stage-1",
      workItemId: upstream,
      stageName: "实施",
      stageStatus: "执行中",
      createdAt: now,
      updatedAt: now,
      ownerEmail: OWNER,
      orgId: ORG_ID,
    });

    const result = await asUser(() =>
      enqueueWorkItem.run({ workItemId: downstream }),
    );
    expect(result.status).toBe("blocked");

    const waitingOn = JSON.parse(result.waitingOn);
    expect(waitingOn.type).toBe("dependency");
    expect(waitingOn.items).toHaveLength(1);
    expect(waitingOn.items[0].id).toBe(upstream);

    // Legacy blockedBy column still written alongside the new waitingOn.
    const blockedBy = JSON.parse(result.blockedBy);
    expect(blockedBy).toHaveLength(1);
    expect(blockedBy[0].id).toBe(upstream);
  });
});
