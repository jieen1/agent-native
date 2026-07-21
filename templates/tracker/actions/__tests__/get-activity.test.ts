import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { createClient, type Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import {
  afterAll,
  afterEach,
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

const mockCallOrchestratorTool = vi.fn();
vi.mock("../../server/lib/orchestrator-client.js", () => ({
  callOrchestratorTool: (...args: unknown[]) =>
    mockCallOrchestratorTool(...args),
}));

type AnyAction = { run: (args: any) => Promise<any> };
let getActivity: AnyAction;

const OWNER = "owner@example.com";
const ORG_ID = "org-f9";

function asUser(fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: OWNER, orgId: ORG_ID }, fn);
}

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "get-activity-"));
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
      owner_email TEXT NOT NULL,
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

  const mod = await import("../get-activity.js");
  getActivity = mod.default as unknown as AnyAction;
});

afterAll(() => {
  client?.close();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  mockCallOrchestratorTool.mockReset();
  await client.executeMultiple(`
    DELETE FROM tracker_activities;
    DELETE FROM tracker_work_items;
    DELETE FROM tracker_links;
    DELETE FROM tracker_exec_queue;
  `);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function insertItem(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  const id =
    (overrides.id as string) ?? `wi_${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(trackerSchema.workItems).values({
    id,
    projectId: "proj-1",
    title: "Test item",
    description: "",
    status: "dispatched",
    createdAt: now,
    updatedAt: now,
    ownerEmail: OWNER,
    orgId: ORG_ID,
    itemKey: "F9-1",
    currentStageName: "实施",
    orchestratorThreadId: "bt_1",
    ...overrides,
  } as any);
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
// T-F9-07: get-activity 去裸 SQL (SDLC-034b 关闭)
// ============================================================================
describe("T-F9-07a: 代码级断言 — get-activity.ts 源码不再含 brain_tasks 裸 SQL", () => {
  it("grep: no literal 'brain_tasks' table reference remains as an executable SQL string", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(
      path.join(here, "..", "get-activity.ts"),
      "utf8",
    );
    // Only the doc-comment describing the OLD approach may mention it in prose
    // (as a code-comment, never as part of a live `sql:`/template literal).
    // Assert there's no `FROM brain_tasks` / `brain_tasks WHERE` SQL fragment.
    expect(src).not.toMatch(/FROM\s+brain_tasks/i);
    expect(src).not.toMatch(/getDbExec/);
  });
});

describe("T-F9-07b: 功能 — orchestrator 的 brain-task-slot 调用失败时降级为 null, 渲染不破", () => {
  it("brain-task-slot rejects (orchestrator down / tool missing) → slot=null, action still returns a full payload without throwing", async () => {
    const id = await insertItem();
    mockCallOrchestratorTool.mockImplementation(
      async (_owner: string, tool: string) => {
        if (tool === "brain-task-slot")
          throw new Error("tool not found (older orchestrator build)");
        if (tool === "brain-thread")
          return { data: { thread: {}, events: [] } };
        if (tool === "runsList") return { data: [] };
        if (tool === "spawnList") return { data: [] };
        if (tool === "brain-queue-status") return { data: {} };
        return { data: null };
      },
    );

    const result = await asUser(() => getActivity.run({ workItemId: id }));
    expect(result.dispatched).toBe(true);
    expect(result.slot).toBeNull();
    // Untouched — no crash, no spurious status flip.
    const row = await fetchItem(id);
    expect(row.status).toBe("dispatched");
  });

  it("brain-task-slot returns a non-object / malformed payload → also degrades to null (not a throw)", async () => {
    const id = await insertItem();
    mockCallOrchestratorTool.mockImplementation(
      async (_owner: string, tool: string) => {
        if (tool === "brain-task-slot") return { data: "not-an-object" };
        if (tool === "brain-thread")
          return { data: { thread: {}, events: [] } };
        if (tool === "runsList") return { data: [] };
        if (tool === "spawnList") return { data: [] };
        if (tool === "brain-queue-status") return { data: {} };
        return { data: null };
      },
    );

    const result = await asUser(() => getActivity.run({ workItemId: id }));
    expect(result.slot).toBeNull();
  });
});

// ============================================================================
// T-F9-08: brain-task-slot 新查询路径与旧裸 SQL 路径的行为等价对比.
//
// 诚实范围声明: orchestrator 侧的 `brain-task-slot` action 本身(它读
// brain_tasks 表并把行整形为 {status,runId,updatedAt})不在本次"tracker 侧"
// 范围内 —— 这里只能覆盖 tracker 这一端的等价性: 给定与旧裸 SQL 行等价的
// {status,runId,updatedAt} 三元组,新调用路径(get-activity.ts 经
// callOrchestratorTool 调用)必须把它一路映射到与旧实现完全相同的
// itemStatus/currentStageName/orchestratorRunId 派生结果 —— 即 get-activity
// 里游 readBrainTaskSlot 之后的全部派生逻辑(deriveItemStatus /
// deriveWritebackStage,均未改动)对新旧两种"底层取数方式"必须无感。
// ============================================================================
describe("T-F9-08: 新旧查询路径的行为等价(tracker 侧范围)", () => {
  it("slot.status='done' (等价于旧 brain_tasks 行 status='done') → itemStatus='returned', runId 透传一致", async () => {
    const id = await insertItem({ currentStageName: "实施" });
    mockCallOrchestratorTool.mockImplementation(
      async (_owner: string, tool: string) => {
        if (tool === "brain-task-slot") {
          // Shape-equivalent to what the OLD raw SQL row {status, run_id,
          // updated_at} used to produce after readBrainTaskSlot's own mapping.
          return {
            data: {
              status: "done",
              runId: "run_equiv",
              updatedAt: "2026-07-10T00:00:00Z",
            },
          };
        }
        if (tool === "brain-thread")
          return { data: { thread: {}, events: [] } };
        if (tool === "runsList") return { data: [] };
        if (tool === "spawnList") return { data: [] };
        if (tool === "brain-queue-status") return { data: {} };
        return { data: null };
      },
    );

    const result = await asUser(() => getActivity.run({ workItemId: id }));
    expect(result.itemStatus).toBe("returned"); // deriveItemStatus('done', ...) === 'returned', unchanged
    expect(result.currentStageName).toBe("测试"); // no strong delivery parsed → capped at 测试
    expect(result.orchestratorRunId).toBe("run_equiv");

    const row = await fetchItem(id);
    expect(row.status).toBe("returned");
    expect((row as any).execState).toBe("returned");
  });

  it("slot.status='running' → itemStatus='running' regardless of any parsed delivery text (unchanged semantics)", async () => {
    const id = await insertItem({ currentStageName: "实施" });
    mockCallOrchestratorTool.mockImplementation(
      async (_owner: string, tool: string) => {
        if (tool === "brain-task-slot") {
          return {
            data: { status: "running", runId: "run_live", updatedAt: null },
          };
        }
        if (tool === "brain-thread")
          return { data: { thread: {}, events: [] } };
        if (tool === "runsList") return { data: [] };
        if (tool === "spawnList") return { data: [] };
        if (tool === "brain-queue-status") return { data: {} };
        return { data: null };
      },
    );

    const result = await asUser(() => getActivity.run({ workItemId: id }));
    expect(result.itemStatus).toBe("running");
    expect(result.currentStageName).toBe("实施"); // never advances while slot is live
  });
});
