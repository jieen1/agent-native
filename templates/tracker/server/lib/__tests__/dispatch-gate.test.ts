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

import * as trackerSchema from "../../db/schema.js";

// ============================================================================
// 缺陷-reevaluateBlockedQueue 的 links/execQueue 查询无 owner/org 范围限定
// (工单 qjcolsz42v) — server/lib/dispatch-gate.ts's reevaluateBlockedQueue.
//
// Real exploit chain reproduced here (not a synthetic worry): add-link.ts
// only ownerScope-validates `fromItemId` — `toItemId` is checked for mere
// existence (see add-link.ts's "Validate that the target work item exists"),
// so an org can create its OWN "blocked-by" link row whose toItemId points at
// ANOTHER org's work item id. When that other org later completes its own
// 实施 stage and calls reevaluateBlockedQueue(db, itsOwnOwnerEmail,
// itsOwnOrgId, itsOwnCompletedItemId), the unscoped links/exec_queue selects
// let that call discover and (once resolveDispatchGate resolves ready=true,
// since the upstream item genuinely belongs to the CALLING org) directly
// UPDATE the first org's own exec_queue/work_items rows — flipping a
// foreign-tenant item from blocked -> queued and writing a misattributed
// activity row on it, all without ever validating fromItemId belongs to the
// calling org/owner.
// ============================================================================

let client: Client;
let db: LibSQLDatabase<typeof trackerSchema>;
let dbDir: string;

vi.mock("../../db/index.js", () => ({
  getDb: () => db,
  schema: trackerSchema,
}));

type DispatchGateModule = typeof import("../dispatch-gate.js");
let reevaluateBlockedQueue: DispatchGateModule["reevaluateBlockedQueue"];

const OWNER_A = "owner-a@example.com";
const ORG_A = "org-a";
const OWNER_B = "owner-b@example.com";
const ORG_B = "org-b";

function asUser(
  userEmail: string,
  orgId: string | null,
  fn: () => Promise<any> | any,
) {
  return runWithRequestContext({ userEmail, orgId: orgId ?? undefined }, fn);
}

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-gate-"));
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
      position INTEGER,
      waiting_on TEXT DEFAULT '{}',
      health_check_log TEXT,
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

  const mod = await import("../dispatch-gate.js");
  reevaluateBlockedQueue = mod.reevaluateBlockedQueue;
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
});

async function insertWorkItem(
  id: string,
  ownerEmail: string,
  orgId: string | null,
  overrides: Record<string, unknown> = {},
) {
  const now = new Date().toISOString();
  await db.insert(trackerSchema.workItems).values({
    id,
    projectId: "proj-1",
    type: "task",
    title: `Item ${id}`,
    description: "",
    status: "blocked",
    priority: 1,
    createdAt: now,
    updatedAt: now,
    ownerEmail,
    orgId,
    itemKey: id.toUpperCase(),
    currentStageName: "实施",
    ...overrides,
  });
}

async function insertStage(
  workItemId: string,
  stageName: string,
  stageStatus: string,
  ownerEmail: string,
  orgId: string | null,
) {
  const now = new Date().toISOString();
  await db.insert(trackerSchema.stages).values({
    id: `stage_${workItemId}_${stageName}`,
    workItemId,
    stageName,
    stageStatus,
    deliveryItems: "[]",
    verdict: null,
    startedAt: now,
    completedAt: stageStatus === "已完成" ? now : null,
    createdAt: now,
    updatedAt: now,
    ownerEmail,
    orgId,
    visibility: "private",
  });
}

async function insertLink(
  fromItemId: string,
  toItemId: string,
  ownerEmail: string,
  orgId: string | null,
) {
  const now = new Date().toISOString();
  await db.insert(trackerSchema.links).values({
    id: `link_${fromItemId}_${toItemId}`,
    fromItemId,
    toItemId,
    linkType: "blocked-by",
    createdAt: now,
    ownerEmail,
    orgId,
  });
}

async function insertExecQueue(
  workItemId: string,
  status: string,
  ownerEmail: string,
  orgId: string | null,
  blockedBy: string = "[]",
) {
  const now = new Date().toISOString();
  await db.insert(trackerSchema.execQueue).values({
    id: `q_${workItemId}`,
    workItemId,
    priority: 0,
    status,
    currentStage: "实施",
    enqueuedAt: now,
    startedAt: null,
    blockedBy,
    ownerEmail,
    orgId,
  });
}

async function fetchExecQueue(workItemId: string) {
  return (
    await db
      .select()
      .from(trackerSchema.execQueue)
      .where(eq(trackerSchema.execQueue.workItemId, workItemId))
  )[0];
}

async function fetchWorkItem(id: string) {
  return (
    await db
      .select()
      .from(trackerSchema.workItems)
      .where(eq(trackerSchema.workItems.id, id))
  )[0];
}

async function fetchActivities(workItemId: string) {
  return await db
    .select()
    .from(trackerSchema.activities)
    .where(eq(trackerSchema.activities.workItemId, workItemId));
}

describe("reevaluateBlockedQueue — cross-tenant scoping (qjcolsz42v)", () => {
  it("same-org: downstream item is unblocked when the gate clears (positive control)", async () => {
    await insertWorkItem("up-a", OWNER_A, ORG_A, { currentStageName: "实施" });
    await insertStage("up-a", "实施", "已完成", OWNER_A, ORG_A);
    await insertWorkItem("down-a", OWNER_A, ORG_A, {
      status: "blocked",
      currentStageName: "待办",
    });
    await insertLink("down-a", "up-a", OWNER_A, ORG_A);
    await insertExecQueue("down-a", "blocked", OWNER_A, ORG_A, '["up-a"]');

    await asUser(OWNER_A, ORG_A, () =>
      reevaluateBlockedQueue(db, OWNER_A, ORG_A, "up-a"),
    );

    const queueRow = await fetchExecQueue("down-a");
    expect(queueRow.status).toBe("queued");
    expect(queueRow.blockedBy).toBe("[]");

    const item = await fetchWorkItem("down-a");
    expect(item.status).toBe("queued");

    const acts = await fetchActivities("down-a");
    expect(acts).toHaveLength(1);
    expect(acts[0]!.eventType).toBe("解除阻塞");
    expect(acts[0]!.ownerEmail).toBe(OWNER_A);
    expect(acts[0]!.orgId).toBe(ORG_A);
  });

  it("cross-tenant: org B completing its own item must NOT read or write org A's link/queue/work-item rows", async () => {
    // Org A creates a "blocked-by" link whose toItemId points at an item
    // that (unknown to org A's own scoping, since add-link.ts only validates
    // fromItemId) belongs to org B. The link row itself is legitimately
    // owned by org A.
    await insertWorkItem("up-b", OWNER_B, ORG_B, { currentStageName: "实施" });
    await insertWorkItem("down-a", OWNER_A, ORG_A, {
      status: "blocked",
      currentStageName: "待办",
    });
    await insertLink("down-a", "up-b", OWNER_A, ORG_A);
    await insertExecQueue("down-a", "blocked", OWNER_A, ORG_A, '["up-b"]');

    const queueBefore = await fetchExecQueue("down-a");
    const itemBefore = await fetchWorkItem("down-a");

    // Org B completes its OWN 实施 stage on its OWN item and calls
    // reevaluateBlockedQueue under its OWN request context — exactly how
    // actions/complete-stage.ts and actions/get-activity.ts invoke it.
    await insertStage("up-b", "实施", "已完成", OWNER_B, ORG_B);
    await asUser(OWNER_B, ORG_B, () =>
      reevaluateBlockedQueue(db, OWNER_B, ORG_B, "up-b"),
    );

    // Org A's exec_queue row must be untouched — no cross-tenant write.
    const queueAfter = await fetchExecQueue("down-a");
    expect(queueAfter.status).toBe(queueBefore.status);
    expect(queueAfter.status).toBe("blocked");
    expect(queueAfter.blockedBy).toBe(queueBefore.blockedBy);

    // Org A's work_item row must be untouched.
    const itemAfter = await fetchWorkItem("down-a");
    expect(itemAfter.status).toBe(itemBefore.status);
    expect(itemAfter.status).toBe("blocked");

    // No activity row must have been written against org A's item on org
    // B's behalf (misattributed audit entry).
    const acts = await fetchActivities("down-a");
    expect(acts).toHaveLength(0);
  });
});
