import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { createClient, type Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as trackerSchema from "../../server/db/schema.js";
import { writebackActorEmail } from "../../server/lib/writeback-actor.js";

let client: Client;
let db: LibSQLDatabase<typeof trackerSchema>;
let dbDir: string;

vi.mock("../../server/db/index.js", () => ({
  getDb: () => db,
  schema: trackerSchema,
}));

type AnyAction = { run: (args: any, ctx?: any) => Promise<any> };
let writebackExecState: AnyAction;

const OWNER = "owner@example.com";
const ORG_ID = "org-f9";
const WRITEBACK_EMAIL = writebackActorEmail();

function asUser(fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: OWNER, orgId: ORG_ID }, fn);
}
function asWriteback(fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: WRITEBACK_EMAIL, orgId: ORG_ID }, fn);
}
function mcpCtx() {
  return { caller: "mcp" as const };
}
function toolCtx() {
  return { caller: "tool" as const };
}

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "writeback-exec-state-"));
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

  const mod = await import("../writeback-exec-state.js");
  writebackExecState = mod.default as unknown as AnyAction;
});

afterAll(() => {
  client?.close();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.executeMultiple(`
    DELETE FROM tracker_activities;
    DELETE FROM tracker_work_items;
  `);
});

async function insertItem(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  const id = (overrides.id as string) ?? `wi_${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(trackerSchema.workItems).values({
    id,
    projectId: "proj-1",
    type: "task",
    title: "Test item",
    description: "",
    status: "dispatched",
    priority: 1,
    createdAt: now,
    updatedAt: now,
    ownerEmail: OWNER,
    orgId: ORG_ID,
    itemKey: "F9-1",
    currentStageName: "实施",
    execState: "dispatched",
    ...overrides,
  } as any);
  return id;
}

async function fetchItem(id: string) {
  return (
    await db.select().from(trackerSchema.workItems).where(eq(trackerSchema.workItems.id, id))
  )[0];
}

async function fetchActivities(id: string) {
  return db
    .select()
    .from(trackerSchema.activities)
    .where(eq(trackerSchema.activities.workItemId, id));
}

// ============================================================================
// T-F9-03: zero-delivery 失败路径 — brain 零交付(thread error 且无 workflowRun)
// → execState 回 'queued'(T-F3-06 async 半边闭合)，业务阶段纹丝不动。
// ============================================================================
describe("T-F9-03: zero-delivery 失败路径 (writeback-exec-state → queued)", () => {
  it("dispatched → queued: writes execState + a dispatch.failed activity; currentStageName/status untouched", async () => {
    const id = await insertItem({ currentStageName: "实施", execState: "dispatched" });

    const result = await asWriteback(() =>
      writebackExecState.run(
        { workItemId: id, target: "queued", reason: "brain-thread-error-zero-delivery" },
        mcpCtx(),
      ),
    );
    expect(result.noop).toBe(false);
    expect(result.execState).toBe("queued");

    const row = await fetchItem(id);
    expect((row as any).execState).toBe("queued");
    // 业务阶段纹丝不动 — 白名单严格 = execState + 活动流, 绝不碰 currentStageName.
    expect(row.currentStageName).toBe("实施");

    const acts = await fetchActivities(id);
    expect(acts).toHaveLength(1);
    expect(acts[0]!.eventType).toBe("dispatch.failed");
    const payload = JSON.parse(acts[0]!.payload as string);
    expect(payload.from).toBe("dispatched");
    expect(payload.to).toBe("queued");
    expect(payload.reason).toBe("brain-thread-error-zero-delivery");
  });
});

// ============================================================================
// Idempotency: target === current execState → noop, zero writes.
// ============================================================================
describe("writeback-exec-state 幂等", () => {
  it("target already equals current execState → {noop:true}, zero activity rows", async () => {
    const id = await insertItem({ execState: "queued" });
    const result = await asWriteback(() =>
      writebackExecState.run({ workItemId: id, target: "queued" }, mcpCtx()),
    );
    expect(result.noop).toBe(true);
    const acts = await fetchActivities(id);
    expect(acts).toHaveLength(0);
  });

  it("never-dispatched item (execState=null) → structured 'not-dispatched' error, zero writes", async () => {
    const id = await insertItem({ execState: null, status: "open" });
    await expect(
      asWriteback(() =>
        writebackExecState.run({ workItemId: id, target: "queued" }, mcpCtx()),
      ),
    ).rejects.toMatchObject({ code: "not-dispatched" });
    const row = await fetchItem(id);
    expect((row as any).execState).toBeNull();
    expect(await fetchActivities(id)).toHaveLength(0);
  });
});

// ============================================================================
// T-F9-05: 非回写身份调窄 action → 结构化拒绝, 活动零残留.
// ============================================================================
describe("T-F9-05: 非回写身份调 writeback-exec-state", () => {
  it("human (frontend-style ctx, real userEmail) → rejected, zero writes", async () => {
    const id = await insertItem();
    await expect(
      asUser(() =>
        writebackExecState.run(
          { workItemId: id, target: "queued" },
          { caller: "frontend" },
        ),
      ),
    ).rejects.toMatchObject({ code: "actor-denied" });
    const row = await fetchItem(id);
    expect((row as any).execState).toBe("dispatched"); // untouched
    expect(await fetchActivities(id)).toHaveLength(0);
  });

  it("normal agent tool-loop call (caller='tool') → rejected even with a resolved email", async () => {
    const id = await insertItem();
    await expect(
      asUser(() => writebackExecState.run({ workItemId: id, target: "queued" }, toolCtx())),
    ).rejects.toMatchObject({ code: "actor-denied" });
    expect(await fetchActivities(id)).toHaveLength(0);
  });

  it("caller='mcp' but NOT the writeback sentinel email → rejected (no free ride via the mcp surface alone)", async () => {
    const id = await insertItem();
    await expect(
      asUser(() => writebackExecState.run({ workItemId: id, target: "queued" }, mcpCtx())),
    ).rejects.toMatchObject({ code: "actor-denied" });
    expect(await fetchActivities(id)).toHaveLength(0);
  });
});
