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
let completeStage: AnyAction;

const OWNER = "owner@example.com";
const ORG_ID = "org-f3";

function asUser(fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: OWNER, orgId: ORG_ID }, fn);
}

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "complete-stage-"));
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
    CREATE TABLE tracker_exec_queue (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL UNIQUE,
      priority INTEGER DEFAULT 0,
      status TEXT DEFAULT 'queued',
      current_stage TEXT DEFAULT '',
      enqueued_at TEXT NOT NULL,
      started_at TEXT,
      blocked_by TEXT DEFAULT '[]',
      owner_email TEXT NOT NULL,
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
  `);

  const mod = await import("../complete-stage.js");
  completeStage = mod.default as unknown as AnyAction;
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
  `);
});

async function insertItemAndStage(
  stageName: string,
  itemOverrides: Record<string, unknown> = {},
) {
  const now = new Date().toISOString();
  const id = `wi_${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(trackerSchema.workItems).values({
    id,
    projectId: "proj-1",
    type: "task",
    title: "Test item",
    description: "",
    status: "open",
    priority: 1,
    createdAt: now,
    updatedAt: now,
    ownerEmail: OWNER,
    orgId: ORG_ID,
    itemKey: "F3-1",
    currentStageName: stageName,
    ...itemOverrides,
  });
  await db.insert(trackerSchema.stages).values({
    id: `stage_${id}`,
    workItemId: id,
    stageName,
    stageStatus: "执行中",
    deliveryItems: "[]",
    verdict: null,
    startedAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ownerEmail: OWNER,
    orgId: ORG_ID,
    visibility: "private",
  });
  return id;
}

async function fetchItem(id: string) {
  return (
    await db
      .select()
      .from(trackerSchema.workItems)
      .where(eq(trackerSchema.workItems.id, id))
  )[0];
}

// ============================================================================
// T-F3-04: complete-stage 拒写 done (旧直写通道封死)
// ============================================================================

describe("T-F3-04: complete-stage 不再直写 status=done", () => {
  it("completing the 交付 stage marks the stage 已完成 but leaves work_item.status untouched, and returns a doneChannel hint (not an error)", async () => {
    const id = await insertItemAndStage("交付", { status: "open" });

    const before = await fetchItem(id);
    expect(before.status).toBe("open");

    const result = await asUser(() =>
      completeStage.run({
        workItemId: id,
        stageName: "交付",
        verdict: { result: "PASSED" },
      }),
    );

    expect(result.stageStatus).toBe("已完成");
    // NOT an error — the stage completion itself succeeded.
    expect(result.doneChannel).toBeTruthy();
    expect(String(result.doneChannel)).toMatch(/transition-work-item/);

    const after = await fetchItem(id);
    // work_item.status is UNCHANGED by completing 交付 — done is only
    // reachable through transition-work-item now (B3 复发防).
    expect(after.status).toBe("open");
  });

  it("completing a non-交付 stage (e.g. 实施) has no doneChannel hint and never touches status", async () => {
    const id = await insertItemAndStage("实施", { status: "open" });
    const result = await asUser(() =>
      completeStage.run({ workItemId: id, stageName: "实施" }),
    );
    expect(result.doneChannel).toBeNull();
    const after = await fetchItem(id);
    expect(after.status).toBe("open");
  });
});

// ============================================================================
// T-F3-16: complete-stage verdict.result 必填枚举
// ============================================================================

describe("T-F3-16: complete-stage verdict.result 必填枚举", () => {
  it("rejects a verdict object missing `result`", async () => {
    const id = await insertItemAndStage("交付");
    await expect(
      asUser(() =>
        completeStage.run({
          workItemId: id,
          stageName: "交付",
          verdict: { notes: "looks fine" } as any,
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects a verdict.result with a non-enum value", async () => {
    const id = await insertItemAndStage("交付");
    await expect(
      asUser(() =>
        completeStage.run({
          workItemId: id,
          stageName: "交付",
          verdict: { result: "LGTM" } as any,
        }),
      ),
    ).rejects.toThrow();
  });

  it("accepts a legal verdict.result (PASSED) and passes through extra fields (passthrough)", async () => {
    const id = await insertItemAndStage("交付");
    const result = await asUser(() =>
      completeStage.run({
        workItemId: id,
        stageName: "交付",
        verdict: { result: "PASSED", notes: "all good" },
      }),
    );
    expect(result.stageStatus).toBe("已完成");
  });

  it("accepts a legal verdict.result (CHANGES_REQUESTED)", async () => {
    const id = await insertItemAndStage("交付");
    const result = await asUser(() =>
      completeStage.run({
        workItemId: id,
        stageName: "交付",
        verdict: { result: "CHANGES_REQUESTED" },
      }),
    );
    expect(result.stageStatus).toBe("已完成");
  });

  it("completing a stage with NO verdict at all still succeeds (verdict itself remains optional)", async () => {
    const id = await insertItemAndStage("实施");
    const result = await asUser(() =>
      completeStage.run({ workItemId: id, stageName: "实施" }),
    );
    expect(result.stageStatus).toBe("已完成");
  });

  it("交付 completion with CHANGES_REQUESTED verdict STILL does not write done (承接 T-F3-04)", async () => {
    const id = await insertItemAndStage("交付", { status: "open" });
    await asUser(() =>
      completeStage.run({
        workItemId: id,
        stageName: "交付",
        verdict: { result: "CHANGES_REQUESTED" },
      }),
    );
    const after = await fetchItem(id);
    expect(after.status).toBe("open");
  });
});
