import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { createClient, type Client } from "@libsql/client";
import { desc, eq } from "drizzle-orm";
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
import { writebackActorEmail } from "../../server/lib/writeback-actor.js";

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

type AnyAction = { run: (args: any, ctx?: any) => Promise<any> };
let advanceStage: AnyAction;
let writebackRunMeta: AnyAction;
let transitionWorkItem: AnyAction;

const OWNER = "owner@example.com";
const ORG_ID = "org-f9";
const WRITEBACK_EMAIL = writebackActorEmail();

function asUser(fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: OWNER, orgId: ORG_ID }, fn);
}
function asWriteback(fn: () => Promise<any> | any) {
  // The writeback channel's JWT sets `sub` to the reserved sentinel and
  // `org_id` to the item's real org (see dispatch-to-orchestrator.ts's tags
  // enrichment + writeback-actor.ts's module doc) — org_id alone is enough
  // for ownerScope()'s OR-clause to admit the row without needing `sub` to
  // equal the real owner.
  return runWithRequestContext(
    { userEmail: WRITEBACK_EMAIL, orgId: ORG_ID },
    fn,
  );
}
function mcpCtx() {
  return { caller: "mcp" as const };
}

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "writeback-integration-"));
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
  `);

  const advMod = await import("../advance-stage.js");
  advanceStage = advMod.default as unknown as AnyAction;
  const wbRunMod = await import("../writeback-run-meta.js");
  writebackRunMeta = wbRunMod.default as unknown as AnyAction;
  const twMod = await import("../transition-work-item.js");
  transitionWorkItem = twMod.default as unknown as AnyAction;
});

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
    DELETE FROM tracker_projects;
    DELETE FROM tracker_work_item_runs;
  `);
  await db.insert(trackerSchema.projects).values({
    id: "proj-1",
    key: "F9",
    name: "F9 Project",
    description: "",
    gitRemote: "git@example.com:f9.git",
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
    execState: "dispatched",
    plannedStages: "[]",
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

async function fetchActivities(id: string) {
  return db
    .select()
    .from(trackerSchema.activities)
    .where(eq(trackerSchema.activities.workItemId, id));
}

async function fetchRuns(id: string) {
  return db
    .select()
    .from(trackerSchema.workItemRuns)
    .where(eq(trackerSchema.workItemRuns.workItemId, id))
    .orderBy(desc(trackerSchema.workItemRuns.dispatchedAt));
}

// ============================================================================
// T-F9-01: 成功终态回写全链(tracker 侧范围).
//
// 诚实范围声明: onRunTerminal 本身(mock run done → 判定 branch/交付 → 依次调
// tracker action)是 orchestrator 侧 server/tracker-client.ts 的职责,不在本次
// "tracker 侧"实施范围内。这里覆盖的是它必然经过的 TRACKER 这一端: 一旦
// runId/branch 落定, 回写通道对同一工作项依次调用
// writeback-run-meta(补 branch) → advance-stage(实施→测试) →
// advance-stage(测试→验收) 后, 工作项必须落在「验收」、runs 行 branch 非空、
// 每次推进都留活动痕迹。"brain_threads 增 0 行 / 无新增 CC/ACP spawn" 这条断言
// 需要 orchestrator 侧的 brain_threads/v3_spawns 表 —— 那两张表不在 tracker
// schema 里,本测试改用 tracker 自己能证明的等价信号: 全程 ZERO 次
// callOrchestratorTool 调用(整条链路只有 writeback-run-meta/advance-stage 两
// 个确定性 tracker action 调用, 从未触发任何 brain-send/brain-thread 之类的
// brain 参与通道)。
// ============================================================================
describe("T-F9-01: 成功终态回写全链(tracker 侧: writeback-run-meta → advance-stage ×2)", () => {
  it("run done + branch 已知 → runs 行回填 branch, 阶段 实施→测试→验收, 证据齐全, 全程零 brain 参与", async () => {
    const id = await insertItem({
      currentStageName: "实施",
      orchestratorRunId: "run_success",
    });
    await db.insert(trackerSchema.workItemRuns).values({
      id: "wir_1",
      workItemId: id,
      runId: null,
      threadId: "bt_1",
      branch: null,
      dispatchedAt: new Date().toISOString(),
      superseded: 0,
      createdAt: new Date().toISOString(),
      ownerEmail: OWNER,
      orgId: ORG_ID,
      visibility: "private",
    } as any);

    // Step 1: runs 行回填 (F8 backfill, F9 窄 action).
    const backfill = await asWriteback(() =>
      writebackRunMeta.run(
        {
          workItemId: id,
          runId: "run_success",
          branch: "orchestrator/f9-1-fix",
        },
        mcpCtx(),
      ),
    );
    expect(backfill.updated).toBe(true);

    // Step 2/3: 实施→测试→验收 (existing F3/F8 advance-stage, expectedRunId 断言).
    const step2 = await asUser(() =>
      advanceStage.run(
        { scope: "item", id, fromStage: "实施", expectedRunId: "run_success" },
        mcpCtx(),
      ),
    );
    expect(step2.stageName).toBe("测试");
    const step3 = await asUser(() =>
      advanceStage.run(
        { scope: "item", id, fromStage: "测试", expectedRunId: "run_success" },
        mcpCtx(),
      ),
    );
    expect(step3.stageName).toBe("验收");

    const row = await fetchItem(id);
    expect(row.currentStageName).toBe("验收");
    expect(row.status).not.toBe("done"); // 白名单绝不碰 status=done

    const runs = await fetchRuns(id);
    expect(runs[0]!.branch).toBe("orchestrator/f9-1-fix");
    expect(runs[0]!.runId).toBe("run_success");

    const acts = await fetchActivities(id);
    // writeback.run-meta + 推进×2 = 3 条留痕.
    expect(acts.map((a) => a.eventType).sort()).toEqual(
      ["writeback.run-meta", "推进", "推进"].sort(),
    );

    // 无 brain 参与的 tracker 侧等价信号: 整条链路零次 orchestrator 工具调用.
    expect(mockCallOrchestratorTool).not.toHaveBeenCalled();
  });
});

// ============================================================================
// T-F9-04: 回写权限边界 — 用回写身份尝试写 done/closed/回退, 全部拒绝
// (守卫 actor 判定); 白名单集合内成功。
// ============================================================================
describe("T-F9-04: 回写身份的权限边界", () => {
  it("回写身份(sub=哨兵值, caller='mcp')调 transition-work-item target=done — 即便带全套证据也被拒绝(actor-denied)", async () => {
    const id = await insertItem({
      currentStageName: "验收",
      status: "running",
    });
    await expect(
      asWriteback(() =>
        transitionWorkItem.run(
          {
            id,
            target: "done",
            reason: "writeback 越权尝试",
            verdict: "PASSED",
            evidence: { commit: "abcdef1234567" },
          },
          mcpCtx(),
        ),
      ),
    ).rejects.toMatchObject({ code: "actor-denied" });
    const row = await fetchItem(id);
    expect(row.status).not.toBe("done");
  });

  it("回写身份调 transition-work-item target=closed — 拒绝", async () => {
    const id = await insertItem({
      currentStageName: "待办",
      execState: null,
      status: "open",
    });
    await expect(
      asWriteback(() =>
        transitionWorkItem.run(
          { id, target: "closed", reason: "writeback 越权" },
          mcpCtx(),
        ),
      ),
    ).rejects.toMatchObject({ code: "actor-denied" });
  });

  it("回写身份调 transition-work-item 回退(ladder 反向, manual-override)— 拒绝", async () => {
    const id = await insertItem({
      currentStageName: "测试",
      status: "running",
    });
    await expect(
      asWriteback(() =>
        transitionWorkItem.run(
          { id, target: "实施", reason: "writeback 越权回退" },
          mcpCtx(),
        ),
      ),
    ).rejects.toMatchObject({ code: "actor-denied" });
  });

  it("白名单内: 回写身份调 writeback-run-meta / advance-stage 成功", async () => {
    const id = await insertItem({
      currentStageName: "实施",
      orchestratorRunId: "run_ok",
    });
    await db.insert(trackerSchema.workItemRuns).values({
      id: "wir_ok",
      workItemId: id,
      runId: null,
      threadId: "bt_ok",
      branch: null,
      dispatchedAt: new Date().toISOString(),
      superseded: 0,
      createdAt: new Date().toISOString(),
      ownerEmail: OWNER,
      orgId: ORG_ID,
      visibility: "private",
    } as any);

    const meta = await asWriteback(() =>
      writebackRunMeta.run({ workItemId: id, runId: "run_ok" }, mcpCtx()),
    );
    expect(meta.updated).toBe(true);

    const adv = await asUser(() =>
      advanceStage.run(
        { scope: "item", id, fromStage: "实施", expectedRunId: "run_ok" },
        mcpCtx(),
      ),
    );
    expect(adv.stageName).toBe("测试");
  });
});

// ============================================================================
// T-F9-09: 回写与人工并发 — 与 F3 CAS 协同.
//
// 诚实标注: 这是一次真实注入的交错测试, 不是"先后调用"的顺序模拟 —— 通过
// monkeypatch 同一个 libsql `client.execute`, 在 transition-work-item 自己的
// 首次 SELECT(读到它要重新断言的快照)完成、但它的 CAS UPDATE 尚未发出之前,
// 真实地插入一次完整的 advance-stage 调用并等待其落库。这样 transition-work-
// item 的 CAS UPDATE 发出时, WHERE 子句里携带的仍是它读到的"旧快照", 而行已
// 经被 advance-stage 改过 —— 驱动的是 transition-work-item.ts 里真实存在的
// `.returning()` 行数判定代码路径(rowsAffectedFromReturning===0 → code=
// 'conflict'), 不是被测代码之外手写的等价逻辑。
// ============================================================================
describe("T-F9-09: 回写(advance-stage)与人工回退(transition-work-item)并发 — 恰一成功一冲突", () => {
  it("advance-stage 的写入落在 transition-work-item 的读快照与其 CAS 写之间 → advance-stage 成功, transition-work-item 检测到冲突", async () => {
    const id = await insertItem({
      currentStageName: "实施",
      status: "dispatched",
      orchestratorRunId: "run_race",
    });

    const realExecute = client.execute.bind(client);
    let injected = false;
    const spy = vi
      .spyOn(client, "execute")
      .mockImplementation(async (stmt: any) => {
        const result = await realExecute(stmt);
        const sqlText = typeof stmt === "string" ? stmt : (stmt?.sql ?? "");
        if (
          !injected &&
          /select/i.test(sqlText) &&
          /tracker_work_items/i.test(sqlText) &&
          /where/i.test(sqlText)
        ) {
          injected = true;
          // Land the writeback advance for real, BETWEEN transition-work-item's
          // read (which just resolved above) and its subsequent CAS write.
          await asUser(() =>
            advanceStage.run(
              {
                scope: "item",
                id,
                fromStage: "实施",
                expectedRunId: "run_race",
              },
              mcpCtx(),
            ),
          );
        }
        return result;
      });

    // The human's request reads the STALE snapshot (current="实施") and asks
    // to roll back one step further to "待办" — a legitimate backward
    // manual-override GIVEN that stale view. `target` must differ from the
    // stale current state (else assertTransition's target===current noop
    // fires before ever reaching the CAS write, and there's no race left to
    // detect) AND from where advance-stage actually moves the row (测试), so
    // the CAS mismatch is real, not incidental.
    let caught: any = null;
    try {
      await asUser(() =>
        transitionWorkItem.run(
          { id, target: "待办", reason: "人工纠错回退测试(并发注入)" },
          { caller: "frontend" },
        ),
      );
    } catch (e) {
      caught = e;
    }
    spy.mockRestore();

    // advance-stage's write landed first (in the read/write gap) — it wins.
    const row = await fetchItem(id);
    expect(row.currentStageName).toBe("测试");

    // transition-work-item's CAS re-asserted the ORIGINAL (now-stale)
    // snapshot and must surface a structured conflict, not silently clobber
    // advance-stage's result. If the interception above never actually fired
    // (e.g. a libsql/driver internals change means the SELECT no longer goes
    // through client.execute() in the shape this test expects), `injected`
    // stays false and this assertion is the signal that the race was NOT
    // truly exercised — see the `injected` assertion below.
    expect(injected).toBe(true);
    expect(caught).not.toBeNull();
    expect(caught.code).toBe("conflict");

    const acts = await fetchActivities(id);
    // Both actors left a trail: advance-stage's 推进, and — since
    // transition-work-item threw before its own activity insert — only ONE
    // activity row (the advance's), not a silently-clobbered pair.
    expect(acts.filter((a) => a.eventType === "推进")).toHaveLength(1);
  });
});
