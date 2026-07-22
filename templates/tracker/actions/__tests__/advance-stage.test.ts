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

type AnyAction = { run: (args: any, ctx?: any) => Promise<any> };
let advanceStage: AnyAction;

const OWNER = "owner@example.com";
const ORG_ID = "org-f3";

function asUser(fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: OWNER, orgId: ORG_ID }, fn);
}

// Deliberately omit `actionName` so the framework audit wrapper never touches
// the process-global DB singleton (see transition-work-item.test.ts).
function ctxFor(caller: "frontend" | "tool" | "http" | "mcp" | "cli") {
  return { caller, userEmail: OWNER, orgId: ORG_ID };
}

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "advance-stage-"));
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
  `);

  const mod = await import("../advance-stage.js");
  advanceStage = mod.default as unknown as AnyAction;
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
    DELETE FROM tracker_projects;
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
    stageGateConfig: "{}",
    ownerEmail: OWNER,
    orgId: ORG_ID,
  });
});

async function insertItem(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  const id = `wi_${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(trackerSchema.workItems).values({
    id,
    projectId: "proj-1",
    type: "task",
    title: "Test item",
    description: "",
    status: "running",
    priority: 1,
    createdAt: now,
    updatedAt: now,
    ownerEmail: OWNER,
    orgId: ORG_ID,
    itemKey: "F3-1",
    currentStageName: "验收",
    plannedStages: "[]",
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

async function fetchActivities(id: string) {
  return db
    .select()
    .from(trackerSchema.activities)
    .where(eq(trackerSchema.activities.workItemId, id));
}

// ============================================================================
// T-F3-18: advance-stage 终段不落 done + actorKind 真实
// ============================================================================

describe("T-F3-18a: advance-stage 不能推进入交付、绝不写 done", () => {
  it("自「验收」推进(下一段是交付)→ guarded noop, status/stage 均不变, 零活动行", async () => {
    const id = await insertItem({
      currentStageName: "验收",
      status: "running",
    });

    const result = await asUser(() =>
      advanceStage.run(
        { scope: "item", id, fromStage: "验收" },
        ctxFor("frontend"),
      ),
    );
    expect(result.noop).toBe(true);
    expect(result.reason).toBe("delivery-guarded");

    const row = await fetchItem(id);
    expect(row.currentStageName).toBe("验收");
    expect(row.status).toBe("running"); // NOT done — old isFinalDelivery hole closed
    const activities = await fetchActivities(id);
    expect(activities).toHaveLength(0);
  });

  it("自定义 plannedStages 以交付收尾(文档任务 实施→交付)同样被守卫", async () => {
    const id = await insertItem({
      currentStageName: "实施",
      status: "running",
      plannedStages: JSON.stringify(["实施", "交付"]),
    });

    const result = await asUser(() =>
      advanceStage.run(
        { scope: "item", id, fromStage: "实施" },
        ctxFor("frontend"),
      ),
    );
    expect(result.noop).toBe(true);
    expect(result.reason).toBe("delivery-guarded");

    const row = await fetchItem(id);
    expect(row.currentStageName).toBe("实施");
    expect(row.status).toBe("running");
  });

  it("常规推进(实施→测试)仍工作且 status 写 running, 绝不写 done", async () => {
    const id = await insertItem({
      currentStageName: "实施",
      status: "dispatched",
    });

    const result = await asUser(() =>
      advanceStage.run(
        { scope: "item", id, fromStage: "实施" },
        ctxFor("frontend"),
      ),
    );
    expect(result.stageName).toBe("测试");

    const row = await fetchItem(id);
    expect(row.currentStageName).toBe("测试");
    expect(row.status).toBe("running");
  });
});

describe("T-F3-18b: 活动行 actorKind 取真实 actor(不再硬编码 human)", () => {
  it("agent(tool-loop) 调 advance-stage → 活动行 actorKind='agent'", async () => {
    const id = await insertItem({
      currentStageName: "实施",
      status: "running",
    });

    await asUser(() =>
      advanceStage.run(
        { scope: "item", id, fromStage: "实施" },
        ctxFor("tool"),
      ),
    );

    const activities = await fetchActivities(id);
    expect(activities).toHaveLength(1);
    expect(activities[0]!.eventType).toBe("推进");
    expect(activities[0]!.actorKind).toBe("agent");
  });

  it("human(frontend) 调 advance-stage → 活动行 actorKind='human'", async () => {
    const id = await insertItem({
      currentStageName: "测试",
      status: "running",
    });

    await asUser(() =>
      advanceStage.run(
        { scope: "item", id, fromStage: "测试" },
        ctxFor("frontend"),
      ),
    );

    const activities = await fetchActivities(id);
    expect(activities).toHaveLength(1);
    expect(activities[0]!.actorKind).toBe("human");
  });
});

// ============================================================================
// T-F9-02: expectedRunId 幂等 + 阶段起点契约(fromStage 不符 → no-op, 落
// writeback.stage-mismatch 事件). 这是 5A"成功回写的阶段起点契约"段落的可判
// 定断言化 —— 回写以「实施」为起点(实施→测试→验收), 不负责把工作项"搬进"实
// 施; fromStage 断言不符时必须是 no-op(不得强推), 且必须留痕(而不是默默消
// 失), 否则"阶段起点契约"就是一段没有测试背书的散文。
// ============================================================================

describe("T-F9-02a: expectedRunId 幂等(重放同一 run 两次 / 陈旧 runId 一次)", () => {
  it("① 同一 writeback 调用重放两次: 第二次因阶段已推进而 no-op(stage-mismatch), 零额外副作用", async () => {
    const id = await insertItem({
      currentStageName: "实施",
      status: "dispatched",
      orchestratorRunId: "run_current",
    });

    const first = await asUser(() =>
      advanceStage.run(
        { scope: "item", id, fromStage: "实施", expectedRunId: "run_current" },
        ctxFor("mcp"),
      ),
    );
    expect(first.stageName).toBe("测试");

    // Replaying the SAME writeback call again: the item is no longer at
    // 实施 (it already advanced to 测试) — fromStage no longer matches, so
    // this is a no-op, not a duplicate advance to 验收.
    const second = await asUser(() =>
      advanceStage.run(
        { scope: "item", id, fromStage: "实施", expectedRunId: "run_current" },
        ctxFor("mcp"),
      ),
    );
    expect(second.noop).toBe(true);
    expect(second.reason).toBe("stage-mismatch");

    const row = await fetchItem(id);
    expect(row.currentStageName).toBe("测试"); // still exactly one advance happened
  });

  it("② 陈旧(已被取代)runId 回写一次: expectedRunId 与当前 orchestratorRunId 不符 → no-op, 零写入", async () => {
    const id = await insertItem({
      currentStageName: "实施",
      status: "dispatched",
      orchestratorRunId: "run_current", // a redispatch superseded the old run
    });

    const result = await asUser(() =>
      advanceStage.run(
        { scope: "item", id, fromStage: "实施", expectedRunId: "run_stale" },
        ctxFor("mcp"),
      ),
    );
    expect(result.noop).toBe(true);
    expect(result.reason).toBe("run-id-mismatch");

    const row = await fetchItem(id);
    expect(row.currentStageName).toBe("实施"); // zero writes — nothing advanced
    expect(await fetchActivities(id)).toHaveLength(0);
  });
});

describe("T-F9-02b: 阶段起点契约 — fromStage 不符时 no-op + 写 writeback.stage-mismatch 事件", () => {
  it("工作项终态回写时不在「实施」(仍处「待办」，模拟漂移/异常) → no-op, 业务阶段纹丝不动, 落 writeback.stage-mismatch 事件", async () => {
    const id = await insertItem({
      currentStageName: "待办", // NOT 实施 — the writeback channel's expectation doesn't hold
      status: "dispatched",
      orchestratorRunId: "run_x",
    });

    const result = await asUser(() =>
      advanceStage.run(
        { scope: "item", id, fromStage: "实施", expectedRunId: "run_x" },
        ctxFor("mcp"),
      ),
    );
    expect(result.noop).toBe(true);
    expect(result.reason).toBe("stage-mismatch");

    const row = await fetchItem(id);
    // 不搬工作项进实施 — 业务阶段纹丝不动.
    expect(row.currentStageName).toBe("待办");

    const activities = await fetchActivities(id);
    expect(activities).toHaveLength(1);
    expect(activities[0]!.eventType).toBe("writeback.stage-mismatch");
    const payload = JSON.parse(activities[0]!.payload as string);
    expect(payload.expectedFromStage).toBe("实施");
    expect(payload.actualStage).toBe("待办");
    expect(payload.expectedRunId).toBe("run_x");
  });

  it("scope=sprint 的批量级联对同样的 stage-mismatch 保持既有静默跳过(不因本项改动回归)", async () => {
    const now = new Date().toISOString();
    await db.insert(trackerSchema.sprints).values({
      id: "sprint-1",
      projectId: "proj-1",
      name: "S1",
      goal: "",
      status: "进行中",
      phase: "executing",
      createdAt: now,
      updatedAt: now,
      ownerEmail: OWNER,
      orgId: ORG_ID,
    } as any);
    // One item at 实施 (will advance), one at 待办 (mismatch — batch path
    // must keep silently skipping these, no event flood on a normal cascade).
    const idAdvance = await insertItem({
      currentStageName: "实施",
      status: "dispatched",
      sprintId: "sprint-1",
    });
    const idMismatch = await insertItem({
      currentStageName: "待办",
      status: "open",
      sprintId: "sprint-1",
    });

    await asUser(() =>
      advanceStage.run(
        { scope: "sprint", id: "sprint-1", fromStage: "实施" },
        ctxFor("mcp"),
      ),
    );

    expect(await fetchActivities(idMismatch)).toHaveLength(0);
    const rowAdvance = await fetchItem(idAdvance);
    expect(rowAdvance.currentStageName).toBe("测试");
  });
});

// ============================================================================
// HOTFIX: writeback-channel tracker_activities inserts must be idempotent.
//
// The act_wbmismatch_… id is DETERMINISTIC (item id + a `now` timestamp). When
// the F9 writeback sweep retries a run it replays the SAME persisted outcome
// (v3-reconciler.ts `drainWritebackOutbox` → `attemptWritebackDelivery` →
// `onRunTerminal` → advance-stage), so two attempts that land in the same
// timestamp bucket regenerate the SAME activity id. Before the fix the second
// bare INSERT threw a tracker_activities primary-key violation, leaving
// v3_runs.writeback_status stuck at 'pending' with writeback_attempts climbing
// forever — even though the activity was already written. The fix adds
// .onConflictDoNothing() so the retried insert is a no-op, not a failure.
//
// This test freezes the clock (faking ONLY Date, so libsql's real timers/
// promises are untouched) so both calls compute the identical `now` and thus
// the identical deterministic id, then drives the stage-mismatch branch twice.
// ============================================================================

describe("HOTFIX: writeback activity insert is idempotent across a retried writeback (deterministic id collision)", () => {
  it("stage-mismatch writeback replayed twice with a frozen clock → second call does NOT throw and exactly ONE activity row exists", async () => {
    const id = await insertItem({
      currentStageName: "待办", // NOT 实施 — drives the writeback.stage-mismatch branch
      status: "dispatched",
      orchestratorRunId: "run_retry",
    });

    // Freeze ONLY Date (toFake: ["Date"]) so both calls compute the same `now`
    // → the same deterministic act_wbmismatch_ id — without disturbing the
    // libsql client's real timers/promises.
    const fixedNow = new Date("2024-05-06T07:08:09.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(fixedNow);
    try {
      const args = {
        scope: "item",
        id,
        fromStage: "实施",
        expectedRunId: "run_retry",
      } as const;

      const first = await asUser(() => advanceStage.run(args, ctxFor("mcp")));
      expect(first.noop).toBe(true);
      expect(first.reason).toBe("stage-mismatch");

      // The replayed retry: identical payload + identical frozen `now` →
      // identical deterministic activity id. Before the fix this threw a
      // tracker_activities primary-key conflict; now it must be a no-op.
      let second: any;
      await expect(
        asUser(async () => {
          second = await advanceStage.run(args, ctxFor("mcp"));
        }),
      ).resolves.not.toThrow();
      expect(second.noop).toBe(true);
      expect(second.reason).toBe("stage-mismatch");
    } finally {
      vi.useRealTimers();
    }

    // Exactly ONE row for the deterministic id — the second insert was a
    // no-op, not a duplicate (and not a thrown conflict).
    const activities = await fetchActivities(id);
    expect(activities).toHaveLength(1);
    expect(activities[0]!.eventType).toBe("writeback.stage-mismatch");
    const expectedId = `act_wbmismatch_${id.slice(0, 6)}_${fixedNow
      .toISOString()
      .replace(/\D/g, "")
      .slice(0, 14)}`;
    expect(activities[0]!.id).toBe(expectedId);

    // Business stage untouched — the mismatch is still a pure no-op.
    const row = await fetchItem(id);
    expect(row.currentStageName).toBe("待办");
  });
});
