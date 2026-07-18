import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

// callOrchestratorTool is mocked per-test via vi.spyOn on the imported module
// (see below) so each test controls the brain-send response/failure mode.
const mockCallOrchestratorTool = vi.fn();
vi.mock("../../server/lib/orchestrator-client.js", () => ({
  callOrchestratorTool: (...args: unknown[]) =>
    mockCallOrchestratorTool(...args),
}));

type AnyAction = { run: (args: any) => Promise<any> };
let dispatchToOrchestrator: AnyAction;
let bulkDispatchToOrchestrator: AnyAction;

const OWNER = "owner@example.com";
const ORG_ID = "org-f3";

function asUser(fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: OWNER, orgId: ORG_ID }, fn);
}

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-to-orchestrator-"));
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
    CREATE TABLE tracker_work_item_runs (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      run_id TEXT,
      thread_id TEXT,
      branch TEXT,
      dispatched_at TEXT NOT NULL,
      superseded INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      owner_email TEXT NOT NULL,
      org_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
    );
    CREATE TABLE tracker_project_workflow_rules (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      item_type TEXT NOT NULL DEFAULT '',
      nature TEXT NOT NULL DEFAULT '',
      in_sprint INTEGER,
      template_name TEXT NOT NULL,
      default_inputs TEXT NOT NULL DEFAULT '{}',
      priority INTEGER NOT NULL DEFAULT 100,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      owner_email TEXT NOT NULL DEFAULT 'local@localhost',
      org_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
    );
    CREATE TABLE tracker_sprints (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      goal TEXT DEFAULT '',
      status TEXT DEFAULT '规划',
      phase TEXT NOT NULL DEFAULT 'planning',
      executor_thread_id TEXT,
      branch TEXT DEFAULT '',
      start_date TEXT DEFAULT '',
      end_date TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      studio_state TEXT NOT NULL DEFAULT '{}',
      owner_email TEXT NOT NULL,
      org_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
    );
    CREATE TABLE tracker_sprint_artifacts (
      id TEXT PRIMARY KEY,
      sprint_id TEXT NOT NULL,
      doc_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      supersedes TEXT,
      produced_by_kind TEXT NOT NULL DEFAULT 'agent',
      content TEXT NOT NULL DEFAULT '',
      content_ref TEXT,
      created_at TEXT NOT NULL,
      owner_email TEXT NOT NULL,
      org_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
    );
  `);

  const mod = await import("../dispatch-to-orchestrator.js");
  dispatchToOrchestrator = mod.default as unknown as AnyAction;
  const bulkMod = await import("../bulk-dispatch-to-orchestrator.js");
  bulkDispatchToOrchestrator = bulkMod.default as unknown as AnyAction;
}, 30_000);

afterAll(() => {
  client?.close();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  mockCallOrchestratorTool.mockReset();
  await client.executeMultiple(`
    DELETE FROM tracker_activities;
    DELETE FROM tracker_stages;
    DELETE FROM tracker_work_items;
    DELETE FROM tracker_exec_queue;
    DELETE FROM tracker_projects;
    DELETE FROM tracker_links;
    DELETE FROM tracker_work_item_runs;
    DELETE FROM tracker_sprint_artifacts;
    DELETE FROM tracker_sprints;
  `);
  await db.insert(trackerSchema.projects).values({
    id: "proj-1",
    key: "F3",
    name: "F3 Project",
    description: "",
    gitRemote: "git@example.com:f3.git",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ownerEmail: OWNER,
    orgId: ORG_ID,
  });
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
    type: "task",
    title: "Test item",
    description: "requirement text",
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

async function fetchItem(id: string) {
  return (
    await db
      .select()
      .from(trackerSchema.workItems)
      .where(eq(trackerSchema.workItems.id, id))
  )[0];
}

// ============================================================================
// T-F3-05: 派发不推进 (integration)
// ============================================================================

describe("T-F3-05: 派发不推进", () => {
  it("dispatching a 待办 item does NOT advance currentStageName; sets execState='dispatched' instead", async () => {
    const id = await insertItem({ currentStageName: "待办" });
    mockCallOrchestratorTool.mockResolvedValue({
      data: { threadId: "bt_abc123", workspaceId: "ws_1" },
    });

    const result = await asUser(() =>
      dispatchToOrchestrator.run({ workItemId: id }),
    );

    expect(result.status).toBe("dispatched");
    expect(result.execState).toBe("dispatched");
    // currentStageName echoed back UNCHANGED — no stagedAdvanced field at all.
    expect(result.currentStageName).toBe("待办");
    expect(result).not.toHaveProperty("stagedAdvanced");

    const row = await fetchItem(id);
    expect(row.currentStageName).toBe("待办"); // untouched
    expect((row as any).execState).toBe("dispatched");
    expect(row.orchestratorThreadId).toBe("bt_abc123");
  });

  it("dispatching an item already at 实施 also leaves currentStageName exactly as-is", async () => {
    const id = await insertItem({ currentStageName: "实施" });
    mockCallOrchestratorTool.mockResolvedValue({
      data: { threadId: "bt_xyz", workspaceId: null },
    });

    await asUser(() => dispatchToOrchestrator.run({ workItemId: id }));

    const row = await fetchItem(id);
    expect(row.currentStageName).toBe("实施");
    expect((row as any).execState).toBe("dispatched");
  });
});

// ============================================================================
// T-F3-06 (同步路径半): 派发失败零假进度
// ============================================================================

describe("T-F3-06 (同步半): 派发失败零假进度", () => {
  it("missing project.gitRemote → dispatch throws BEFORE any write; execState stays null, currentStageName untouched", async () => {
    // Re-point the project at an empty gitRemote for this test.
    await db
      .update(trackerSchema.projects)
      .set({ gitRemote: "" })
      .where(eq(trackerSchema.projects.id, "proj-1"));

    const id = await insertItem({ currentStageName: "待办" });

    await expect(
      asUser(() => dispatchToOrchestrator.run({ workItemId: id })),
    ).rejects.toThrow();
    expect(mockCallOrchestratorTool).not.toHaveBeenCalled();

    const row = await fetchItem(id);
    expect((row as any).execState).toBeNull();
    expect(row.currentStageName).toBe("待办");
    expect(row.status).toBe("open");
  });

  it("brain-send succeeds but returns no threadId → dispatch throws; no orphan 'dispatched' state", async () => {
    const id = await insertItem({ currentStageName: "待办" });
    mockCallOrchestratorTool.mockResolvedValue({ data: {} }); // no threadId

    await expect(
      asUser(() => dispatchToOrchestrator.run({ workItemId: id })),
    ).rejects.toThrow(/no threadId/);

    const row = await fetchItem(id);
    expect((row as any).execState).toBeNull();
    expect(row.status).toBe("open"); // NOT 'dispatched'
    expect(row.currentStageName).toBe("待办");
  });
});

// ============================================================================
// T-F3-19: bulk-dispatch 与单 dispatch 同法 — 不推进阶段、写 execState
// (SDLC-063 批量路径回归锁: 批量与单件路径分叉 = 假进度洞在批量侧重开)
// ============================================================================

describe("T-F3-19: bulk-dispatch 派发不推进", () => {
  it("批量派发 待办 项 → currentStageName 不变、execState='dispatched'、无 实施 stage 行", async () => {
    const idA = await insertItem({ currentStageName: "待办" });
    const idB = await insertItem({ currentStageName: "设计" });
    mockCallOrchestratorTool.mockResolvedValue({
      data: {
        threadId: "bt_bulk1",
        status: "running",
        taskId: "task_1",
        workspaceId: null,
      },
    });

    const result = await asUser(() =>
      bulkDispatchToOrchestrator.run({ workItemIds: [idA, idB] }),
    );
    expect(result.dispatched).toBe(2);
    expect(result.failed).toBe(0);
    for (const r of result.results) {
      expect(r.ok).toBe(true);
      expect(r.execState).toBe("dispatched");
    }

    const rowA = await fetchItem(idA);
    const rowB = await fetchItem(idB);
    // 业务阶段自始未动 — 与单 dispatch 完全一致 (T-F3-05 的批量镜像).
    expect(rowA.currentStageName).toBe("待办");
    expect(rowB.currentStageName).toBe("设计");
    expect((rowA as any).execState).toBe("dispatched");
    expect((rowB as any).execState).toBe("dispatched");
    // 老路径会 upsert 一个 执行中 的 实施 stage 行 — 现在必须为零.
    const stageRows = await db.select().from(trackerSchema.stages);
    expect(stageRows).toHaveLength(0);
  });

  it("批量结果回显的 currentStageName 是派发前原值(无 stagedAdvanced 概念)", async () => {
    const id = await insertItem({ currentStageName: "实施" });
    mockCallOrchestratorTool.mockResolvedValue({
      data: { threadId: "bt_bulk2", status: "queued", taskId: "task_2" },
    });

    const result = await asUser(() =>
      bulkDispatchToOrchestrator.run({ workItemIds: [id] }),
    );
    expect(result.results[0].currentStageName).toBe("实施");
    expect(result.results[0]).not.toHaveProperty("stagedAdvanced");

    const row = await fetchItem(id);
    expect(row.currentStageName).toBe("实施");
    expect(row.status).toBe("queued"); // slot 状态照记(status 轴不受影响)
  });

  it("bulk 派发失败项(无 threadId)零假进度 — execState/阶段均不动", async () => {
    const id = await insertItem({ currentStageName: "待办" });
    mockCallOrchestratorTool.mockResolvedValue({ data: {} }); // no threadId

    const result = await asUser(() =>
      bulkDispatchToOrchestrator.run({ workItemIds: [id] }),
    );
    expect(result.failed).toBe(1);
    expect(result.results[0].ok).toBe(false);

    const row = await fetchItem(id);
    expect((row as any).execState).toBeNull();
    expect(row.currentStageName).toBe("待办");
    expect(row.status).toBe("open");
  });
});

// ============================================================================
// T-F5-03 / T-F5-04: 派发前置检查(F5 任务拆分阈值,02 §3.10 拆分契约)
// ============================================================================

// A brief whose description references 12 distinct files — computed on the
// fly by dispatch-to-orchestrator.ts's estimateScale() fallback when
// scale_estimate hasn't been persisted yet (mirrors estimate-brief-scale.ts's
// own heuristic — see server/lib/scale-estimate.ts).
const TWELVE_FILE_BRIEF = `
批量导出重构涉及:
- \`server/db/schema.ts\`
- \`server/plugins/db.ts\`
- \`server/lib/export-jobs.ts\`
- \`server/lib/export-runner.ts\`
- \`server/lib/export-retry.ts\`
- \`actions/create-export-job.ts\`
- \`actions/list-export-jobs.ts\`
- \`actions/retry-export-job.ts\`
- \`app/pages/ExportJobsPage.tsx\`
- \`app/pages/ExportJobDetailPage.tsx\`
- \`app/hooks/use-export-jobs.ts\`
- \`app/components/ExportStatusBadge.tsx\`
`;

describe("T-F5-03: 派发拦截 — 超阈值不可静默派发", () => {
  it("12 文件级 brief 直接 dispatch → 结构化错误 scale-exceeded;execState 仍为 null;零活动残留", async () => {
    const id = await insertItem({
      currentStageName: "待办",
      description: TWELVE_FILE_BRIEF,
    });

    let caught: (Error & { code?: string; estimate?: any }) | undefined;
    try {
      await asUser(() => dispatchToOrchestrator.run({ workItemId: id }));
    } catch (e) {
      caught = e as Error & { code?: string; estimate?: any };
    }
    expect(caught?.code).toBe("scale-exceeded");
    expect(caught?.estimate?.verdict).toBe("split-required");
    expect(mockCallOrchestratorTool).not.toHaveBeenCalled();

    const row = await fetchItem(id);
    expect((row as any).execState).toBeNull();
    expect(row.status).toBe("open");
    expect(row.currentStageName).toBe("待办");

    const activities = await db.select().from(trackerSchema.activities);
    expect(activities).toHaveLength(0);
  });

  it("已持久化的 scale_estimate(split-required)同样拦截,不重算", async () => {
    const id = await insertItem({
      currentStageName: "待办",
      description: "无路径的小改动",
      scaleEstimate: JSON.stringify({
        files: 8,
        crossLifecycle: false,
        verdict: "split-required",
        signals: [],
        at: new Date().toISOString(),
      }),
    });

    let caught: (Error & { code?: string }) | undefined;
    try {
      await asUser(() => dispatchToOrchestrator.run({ workItemId: id }));
    } catch (e) {
      caught = e as Error & { code?: string };
    }
    expect(caught?.code).toBe("scale-exceeded");
    expect(mockCallOrchestratorTool).not.toHaveBeenCalled();
  });
});

describe("T-F5-04: 人工覆盖(P12 逃生口 + 审计)", () => {
  it("overrideScale:true → 派发成功;活动流有 scale.overridden(含估算快照)", async () => {
    const id = await insertItem({
      currentStageName: "待办",
      description: TWELVE_FILE_BRIEF,
    });
    mockCallOrchestratorTool.mockResolvedValue({
      data: { threadId: "bt_override1", workspaceId: "ws_1" },
    });

    const result = await asUser(() =>
      dispatchToOrchestrator.run({ workItemId: id, overrideScale: true }),
    );
    expect(result.status).toBe("dispatched");
    expect(result.scaleOverridden).toBe(true);
    expect(mockCallOrchestratorTool).toHaveBeenCalledTimes(1);

    const row = await fetchItem(id);
    expect((row as any).execState).toBe("dispatched");

    const activities = await db
      .select()
      .from(trackerSchema.activities)
      .where(eq(trackerSchema.activities.eventType, "scale.overridden"));
    expect(activities).toHaveLength(1);
    const payload = JSON.parse(activities[0]!.payload);
    expect(payload.estimate.verdict).toBe("split-required");
    expect(payload.estimate.files).toBe(12);
  });

  it("overrideScale:true 但估算 ok(未超阈值)— 不写 scale.overridden(仅在实际覆盖时记录)", async () => {
    const id = await insertItem({
      currentStageName: "待办",
      description: "小改动,无涉及文件",
    });
    mockCallOrchestratorTool.mockResolvedValue({
      data: { threadId: "bt_ok1", workspaceId: null },
    });

    const result = await asUser(() =>
      dispatchToOrchestrator.run({ workItemId: id, overrideScale: true }),
    );
    expect(result.status).toBe("dispatched");
    expect(result.scaleOverridden).toBe(false);

    const activities = await db
      .select()
      .from(trackerSchema.activities)
      .where(eq(trackerSchema.activities.eventType, "scale.overridden"));
    expect(activities).toHaveLength(0);
  });
});

// ============================================================================
// CR-1 (评审必补): bulk-dispatch 走同一个共享规模门(server/lib/scale-gate.ts)
// — 超阈值项逐项 skip(reason=scale-exceeded),不中断整波;支持批级/逐项
// override。防复发:F3 时代 bulk-dispatch 漏「派发不推进」守卫的同文件同类
// 系统盲区,不能在 F5 规模门上重演。
// ============================================================================

describe("CR-1: bulk-dispatch 共享规模门", () => {
  it("超阈值项被逐项 skip(reason=scale-exceeded)、不中断整波、零状态残留;正常项照常派发", async () => {
    const bigId = await insertItem({
      currentStageName: "待办",
      description: TWELVE_FILE_BRIEF,
    });
    const smallId = await insertItem({
      currentStageName: "待办",
      description: "小改动,无涉及文件",
    });
    mockCallOrchestratorTool.mockResolvedValue({
      data: { threadId: "bt_bulk_ok", status: "running", taskId: "task_x" },
    });

    const result = await asUser(() =>
      bulkDispatchToOrchestrator.run({ workItemIds: [bigId, smallId] }),
    );

    expect(result.dispatched).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);

    const bigRes = result.results.find((r: any) => r.workItemId === bigId);
    expect(bigRes.ok).toBe(false);
    expect(bigRes.skipped).toBe(true);
    expect(bigRes.reason).toBe("scale-exceeded");
    expect(bigRes.estimate.verdict).toBe("split-required");

    // Over-scale item: zero state residue (never dispatched).
    const bigRow = await fetchItem(bigId);
    expect((bigRow as any).execState).toBeNull();
    expect(bigRow.status).toBe("open");
    // Small item: dispatched normally — one skip never aborts the wave.
    const smallRow = await fetchItem(smallId);
    expect((smallRow as any).execState).toBe("dispatched");

    // Skip writes NO scale.overridden activity.
    const overridden = await db
      .select()
      .from(trackerSchema.activities)
      .where(eq(trackerSchema.activities.eventType, "scale.overridden"));
    expect(overridden).toHaveLength(0);
  });

  it("批级 overrideScale:true → 超阈值项放行,逐项写 scale.overridden(含快照)", async () => {
    const bigId = await insertItem({
      currentStageName: "待办",
      description: TWELVE_FILE_BRIEF,
    });
    mockCallOrchestratorTool.mockResolvedValue({
      data: { threadId: "bt_bulk_ov", status: "running", taskId: "task_ov" },
    });

    const result = await asUser(() =>
      bulkDispatchToOrchestrator.run({
        workItemIds: [bigId],
        overrideScale: true,
      }),
    );
    expect(result.dispatched).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.results[0].scaleOverridden).toBe(true);

    const row = await fetchItem(bigId);
    expect((row as any).execState).toBe("dispatched");

    const overridden = await db
      .select()
      .from(trackerSchema.activities)
      .where(eq(trackerSchema.activities.eventType, "scale.overridden"));
    expect(overridden).toHaveLength(1);
    expect(JSON.parse(overridden[0]!.payload).estimate.files).toBe(12);
  });

  it("逐项 overrideScaleIds:只放行指定 id,其余超阈值项仍 skip", async () => {
    const overrideId = await insertItem({
      currentStageName: "待办",
      description: TWELVE_FILE_BRIEF,
    });
    const skipId = await insertItem({
      currentStageName: "待办",
      description: TWELVE_FILE_BRIEF,
    });
    mockCallOrchestratorTool.mockResolvedValue({
      data: {
        threadId: "bt_bulk_peritem",
        status: "running",
        taskId: "task_pi",
      },
    });

    const result = await asUser(() =>
      bulkDispatchToOrchestrator.run({
        workItemIds: [overrideId, skipId],
        overrideScaleIds: [overrideId],
      }),
    );
    expect(result.dispatched).toBe(1);
    expect(result.skipped).toBe(1);

    const overrideRow = await fetchItem(overrideId);
    expect((overrideRow as any).execState).toBe("dispatched");
    const skipRow = await fetchItem(skipId);
    expect((skipRow as any).execState).toBeNull();

    const skipRes = result.results.find((r: any) => r.workItemId === skipId);
    expect(skipRes.reason).toBe("scale-exceeded");
  });
});

// ============================================================================
// F8 (回链完整性): every successful dispatch — single OR bulk — writes a
// tracker_work_item_runs row (see server/lib/work-item-runs.ts). Covered here
// end-to-end through the REAL actions (not just the lib's own unit tests in
// server/lib/__tests__/work-item-runs.test.ts).
// ============================================================================

async function fetchRuns(workItemId: string) {
  const { and, desc, eq } = await import("drizzle-orm");
  return db
    .select()
    .from(trackerSchema.workItemRuns)
    .where(eq(trackerSchema.workItemRuns.workItemId, workItemId))
    .orderBy(desc(trackerSchema.workItemRuns.dispatchedAt));
}

describe("T-F8-03: dispatch-to-orchestrator 写 tracker_work_item_runs (单件路径)", () => {
  it("a successful single-item dispatch inserts exactly one live run row", async () => {
    const id = await insertItem({ currentStageName: "待办" });
    mockCallOrchestratorTool.mockResolvedValue({
      data: { threadId: "bt_run1", workspaceId: "ws_1" },
    });

    await asUser(() => dispatchToOrchestrator.run({ workItemId: id }));

    const runs = await fetchRuns(id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.threadId).toBe("bt_run1");
    expect(runs[0]!.superseded).toBe(0);
    expect(runs[0]!.runId).toBeNull(); // unknown at dispatch time — F9 backfills
  });

  it("派发 -> 取消 -> 重派 (B2): redispatch supersedes the prior row and adds a new one — get-work-item.runs length 2", async () => {
    const id = await insertItem({ currentStageName: "待办" });
    mockCallOrchestratorTool.mockResolvedValue({
      data: { threadId: "bt_run_first", workspaceId: null },
    });
    await asUser(() => dispatchToOrchestrator.run({ workItemId: id }));

    // Simulate a cancel (execState -> queued via writeback, out of scope
    // here) followed by a manual redispatch of the SAME item.
    mockCallOrchestratorTool.mockResolvedValue({
      data: { threadId: "bt_run_second", workspaceId: null },
    });
    await asUser(() => dispatchToOrchestrator.run({ workItemId: id }));

    const runs = await fetchRuns(id);
    expect(runs).toHaveLength(2); // T-F8-03
    expect(runs[0]!.threadId).toBe("bt_run_second");
    expect(runs[0]!.superseded).toBe(0);
    expect(runs[1]!.threadId).toBe("bt_run_first");
    expect(runs[1]!.superseded).toBe(1); // old row superseded, not overwritten
  });

  it("a failed dispatch (no threadId) writes ZERO run rows", async () => {
    const id = await insertItem({ currentStageName: "待办" });
    mockCallOrchestratorTool.mockResolvedValue({ data: {} });
    await expect(
      asUser(() => dispatchToOrchestrator.run({ workItemId: id })),
    ).rejects.toThrow();
    expect(await fetchRuns(id)).toHaveLength(0);
  });
});

describe("T-F8-03 (bulk 镜像): bulk-dispatch-to-orchestrator 同样写 tracker_work_item_runs", () => {
  it("每个成功批量派发的 item 各有一行 run 记录（批量路径不得跳过回链）", async () => {
    const idA = await insertItem({ currentStageName: "待办" });
    const idB = await insertItem({ currentStageName: "设计" });
    mockCallOrchestratorTool.mockResolvedValue({
      data: {
        threadId: "bt_bulk_run",
        status: "running",
        taskId: "task_x",
        workspaceId: null,
      },
    });

    await asUser(() =>
      bulkDispatchToOrchestrator.run({ workItemIds: [idA, idB] }),
    );

    expect(await fetchRuns(idA)).toHaveLength(1);
    expect(await fetchRuns(idB)).toHaveLength(1);
  });

  it("批量重派同一 item 两次也遵循追加式历史（同单件路径一致）", async () => {
    const id = await insertItem({ currentStageName: "待办" });
    mockCallOrchestratorTool.mockResolvedValue({
      data: { threadId: "bt_bulk_1", status: "running", taskId: "t1" },
    });
    await asUser(() => bulkDispatchToOrchestrator.run({ workItemIds: [id] }));

    mockCallOrchestratorTool.mockResolvedValue({
      data: { threadId: "bt_bulk_2", status: "running", taskId: "t2" },
    });
    await asUser(() => bulkDispatchToOrchestrator.run({ workItemIds: [id] }));

    const runs = await fetchRuns(id);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.threadId).toBe("bt_bulk_2");
    expect(runs[0]!.superseded).toBe(0);
    expect(runs[1]!.superseded).toBe(1);
  });
});

// ============================================================================
// R4b.3 — §5.5 payload contract: dispatch-to-orchestrator's suggestedInputs
// must carry the item's OWN structured sprint-studio brief (not raw
// description prose) once one has been extracted, and must fall back to the
// pre-existing behavior (no suggestedInputs.spec override) otherwise.
// ============================================================================

async function seedSprint(id: string) {
  const now = new Date().toISOString();
  await db.insert(trackerSchema.sprints).values({
    id,
    projectId: "proj-1",
    name: "R4b3 sprint",
    goal: "",
    status: "进行中",
    phase: "designing",
    startDate: "",
    endDate: "",
    createdAt: now,
    updatedAt: now,
    ownerEmail: OWNER,
    orgId: ORG_ID,
  });
}

async function seedSprintArtifact(
  sprintId: string,
  docKey: string,
  content: string,
) {
  await db.insert(trackerSchema.sprintArtifacts).values({
    id: `art_${docKey.replace(/[^a-zA-Z0-9]/g, "_")}_${Math.random().toString(36).slice(2, 6)}`,
    sprintId,
    docKey,
    kind: "文档",
    name: docKey,
    version: 1,
    producedByKind: "agent",
    content,
    createdAt: new Date().toISOString(),
    ownerEmail: OWNER,
    orgId: ORG_ID,
  });
}

const BRIEF_MD = [
  "# Brief: F3-1 · 测试项",
  "",
  "实现某功能。",
  "",
  "## 涉及文件",
  "",
  "| 文件路径 | 操作 | 说明 |",
  "| --- | --- | --- |",
  "| `actions/some-file.ts` | MODIFY | 说明 |",
].join("\n");

describe("R4b.3: dispatch-to-orchestrator carries the item's structured brief as suggestedInputs", () => {
  it("brief:{itemKey} + shared-brief exist → suggestedInputs.spec/scopeGlobs come from the brief, not the raw description", async () => {
    await seedSprint("sprint-r4b3-1");
    await seedSprintArtifact("sprint-r4b3-1", "brief:F3-1", BRIEF_MD);
    await seedSprintArtifact("sprint-r4b3-1", "shared-brief", "共享约定文本。");

    const id = await insertItem({
      itemKey: "F3-1",
      sprintId: "sprint-r4b3-1",
      description:
        "raw description prose — must NOT reach suggestedInputs.spec",
    });
    mockCallOrchestratorTool.mockResolvedValue({
      data: { threadId: "bt_r4b3_1", workspaceId: "ws_1" },
    });

    await asUser(() => dispatchToOrchestrator.run({ workItemId: id }));

    expect(mockCallOrchestratorTool).toHaveBeenCalledTimes(1);
    const payload = mockCallOrchestratorTool.mock.calls[0]![2] as any;
    expect(payload.suggestedInputs.spec).toContain("实现某功能");
    expect(payload.suggestedInputs.spec).toContain("共享约定文本");
    expect(payload.suggestedInputs.spec).not.toContain("raw description prose");
    expect(payload.suggestedInputs.scopeGlobs).toEqual([
      "actions/some-file.ts",
    ]);
  });

  it("item has no sprintId → suggestedInputs has no brief-derived spec override (pre-R4b.3 behavior unchanged)", async () => {
    const id = await insertItem({
      itemKey: "F3-2",
      description: "raw description prose",
    });
    mockCallOrchestratorTool.mockResolvedValue({
      data: { threadId: "bt_r4b3_2", workspaceId: null },
    });

    await asUser(() => dispatchToOrchestrator.run({ workItemId: id }));

    const payload = mockCallOrchestratorTool.mock.calls[0]![2] as any;
    // defaultInputs is always {} today and no brief payload applies without
    // a sprint — suggestedInputs must be entirely absent, exactly as before.
    expect(payload).not.toHaveProperty("suggestedInputs");
  });

  it("item has a sprintId but extract-briefs hasn't run yet → falls back to no suggestedInputs.spec override", async () => {
    await seedSprint("sprint-r4b3-3");
    const id = await insertItem({
      itemKey: "F3-3",
      sprintId: "sprint-r4b3-3",
      description: "raw description prose",
    });
    mockCallOrchestratorTool.mockResolvedValue({
      data: { threadId: "bt_r4b3_3", workspaceId: null },
    });

    await asUser(() => dispatchToOrchestrator.run({ workItemId: id }));

    const payload = mockCallOrchestratorTool.mock.calls[0]![2] as any;
    expect(payload).not.toHaveProperty("suggestedInputs");
  });
});
