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
let transitionWorkItem: AnyAction;
let getWorkItem: AnyAction;

const OWNER = "owner@example.com";
const ORG_ID = "org-f3";

function asUser(fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: OWNER, orgId: ORG_ID }, fn);
}

// IMPORTANT: deliberately omit `actionName` here. `defineAction`'s audit
// wrapper only touches the DB when `ctx.actionName` is set — including it
// would make this test hit the framework's REAL global audit singleton
// (`getDbExec()`, defaulting to `file:./data/app.db` — this template's actual
// local dev database) since nothing in this file redirects DATABASE_URL.
// `actorFromCaller` only needs `ctx.caller`, so leaving `actionName` out here
// is both safe and sufficient. T-F3-13 (audit) exercises the real pipeline
// deliberately, in its own file, against an isolated temp DATABASE_URL.
function ctxFor(caller: "frontend" | "tool" | "http") {
  return { caller, userEmail: OWNER, orgId: ORG_ID };
}

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "transition-work-item-"));
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
    CREATE TABLE tracker_artifact_reviews (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      review_key TEXT NOT NULL,
      checked INTEGER NOT NULL DEFAULT 0,
      reviewer TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
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
  `);

  const transitionModule = await import("../transition-work-item.js");
  const getWorkItemModule = await import("../get-work-item.js");
  transitionWorkItem = transitionModule.default as unknown as AnyAction;
  getWorkItem = getWorkItemModule.default as unknown as AnyAction;
}, 30_000);

afterAll(() => {
  client?.close();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.executeMultiple(`
    DELETE FROM tracker_activities;
    DELETE FROM tracker_artifact_reviews;
    DELETE FROM tracker_sprint_artifacts;
    DELETE FROM tracker_sprints;
    DELETE FROM tracker_work_items;
    DELETE FROM tracker_projects;
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

async function insertItem(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  const id = (overrides.id as string) ?? `wi_${Math.random().toString(36).slice(2, 8)}`;
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
    currentStageName: "验收",
    ...overrides,
  });
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
// T-F3-03: agent 写 done 机制拒绝 (integration)
// ============================================================================

describe("T-F3-03: agent 写 done 机制拒绝", () => {
  it("MCP/tool-loop caller (agent identity) attempting target=done with full evidence is rejected; state unchanged", async () => {
    const id = await insertItem({ currentStageName: "验收", status: "open" });

    await expect(
      asUser(() =>
        transitionWorkItem.run(
          {
            id,
            target: "done",
            reason: "尝试自动完成",
            verdict: "PASSED",
            evidence: { commit: "abcdef1" },
          },
          ctxFor("tool"),
        ),
      ),
    ).rejects.toThrow();

    const row = await fetchItem(id);
    expect(row.status).toBe("open"); // NOT done
    expect(row.currentStageName).toBe("验收");
  });
});

// ============================================================================
// done 通道: happy path + 源态约束 + CHANGES_REQUESTED 重定向 (02 §8)
// ============================================================================

describe("done 通道: 源态约束与 CHANGES_REQUESTED 重定向", () => {
  it("human 自「待人工评审」(验收) + PASSED + commit → done 落库 (唯一合法 done 路径)", async () => {
    const id = await insertItem({ currentStageName: "验收", status: "open", execState: "returned" });

    const result = await asUser(() =>
      transitionWorkItem.run(
        {
          id,
          target: "done",
          reason: "评审通过,合并完成",
          verdict: "PASSED",
          evidence: { commit: "abcdef1234" },
        },
        ctxFor("frontend"),
      ),
    );
    expect(result.noop).toBe(false);
    expect(result.status).toBe("done");

    const row = await fetchItem(id);
    expect(row.status).toBe("done");
  });

  it("human 自「测试」+ 全证据 → done 被拒 (invalid-source-state), 状态不变", async () => {
    const id = await insertItem({ currentStageName: "测试", status: "open", execState: "dispatched" });

    await expect(
      asUser(() =>
        transitionWorkItem.run(
          {
            id,
            target: "done",
            reason: "试图跳过评审直接完成",
            verdict: "PASSED",
            evidence: { commit: "abcdef1" },
          },
          ctxFor("frontend"),
        ),
      ),
    ).rejects.toThrow(/待人工评审/);

    const row = await fetchItem(id);
    expect(row.status).toBe("open");
    expect(row.currentStageName).toBe("测试");
  });

  it("自「待人工评审」发 done+CHANGES_REQUESTED → 重定向为回退「实施」(驳回返工), 不写 done", async () => {
    const id = await insertItem({ currentStageName: "验收", status: "open", execState: "returned" });

    const result = await asUser(() =>
      transitionWorkItem.run(
        {
          id,
          target: "done",
          reason: "评审发现回归,驳回返工",
          verdict: "CHANGES_REQUESTED",
        },
        ctxFor("frontend"),
      ),
    );
    expect(result.noop).toBe(false);
    expect(result.effectiveTarget).toBe("实施");

    const row = await fetchItem(id);
    expect(row.status).not.toBe("done");
    expect(row.currentStageName).toBe("实施");

    const activities = await fetchActivities(id);
    expect(activities).toHaveLength(1);
    expect(activities[0]!.eventType).toBe("transition.manual-override");
  });

  it("自其他源态(测试)发 done+CHANGES_REQUESTED → 重定向不生效, 按 done 被拒, 零写入", async () => {
    const id = await insertItem({ currentStageName: "测试", status: "open", execState: "dispatched" });

    await expect(
      asUser(() =>
        transitionWorkItem.run(
          {
            id,
            target: "done",
            reason: "非评审态发出的驳回请求",
            verdict: "CHANGES_REQUESTED",
          },
          ctxFor("frontend"),
        ),
      ),
    ).rejects.toThrow();

    const row = await fetchItem(id);
    expect(row.currentStageName).toBe("测试"); // 未被悄悄回退到实施
    expect(row.status).toBe("open");
    const activities = await fetchActivities(id);
    expect(activities).toHaveLength(0);
  });
});

// ============================================================================
// T-F3-09: closed 通道 (未派发限定)
// ============================================================================

describe("T-F3-09: closed 通道(未派发限定)", () => {
  it("① 未派发项 human+reason → closed succeeds; closedReason/closedAt + audit + activity row", async () => {
    const id = await insertItem({ currentStageName: "待办", status: "open", execState: null });

    const result = await asUser(() =>
      transitionWorkItem.run(
        { id, target: "closed", reason: "不再需要,已被上游取消" },
        ctxFor("frontend"),
      ),
    );
    expect(result.noop).toBe(false);
    expect(result.status).toBe("closed");

    const row = await fetchItem(id);
    expect(row.status).toBe("closed");
    expect(row.closedReason).toBe("不再需要,已被上游取消");
    expect(row.closedAt).toBeTruthy();

    const activities = await fetchActivities(id);
    expect(activities.some((a) => a.eventType === "transition.closed")).toBe(true);
  });

  it("② 已派发项(execState=dispatched) → rejected, no state change", async () => {
    const id = await insertItem({
      currentStageName: "实施",
      status: "dispatched",
      execState: "dispatched",
    });

    await expect(
      asUser(() =>
        transitionWorkItem.run(
          { id, target: "closed", reason: "尝试关闭已派发项" },
          ctxFor("frontend"),
        ),
      ),
    ).rejects.toThrow();

    const row = await fetchItem(id);
    expect(row.status).toBe("dispatched");
    expect(row.closedReason).toBeNull();
  });
});

// ============================================================================
// T-F3-10: noop 幂等
// ============================================================================

describe("T-F3-10: noop 幂等", () => {
  it("target==当前态 called twice → {noop:true} both times, zero business-state / activity changes", async () => {
    const id = await insertItem({ currentStageName: "验收", status: "open" });

    const r1 = await asUser(() =>
      transitionWorkItem.run(
        { id, target: "待人工评审", reason: "no-op check" },
        ctxFor("frontend"),
      ),
    );
    expect(r1.noop).toBe(true);

    const r2 = await asUser(() =>
      transitionWorkItem.run(
        { id, target: "待人工评审", reason: "no-op check again" },
        ctxFor("frontend"),
      ),
    );
    expect(r2.noop).toBe(true);

    const row = await fetchItem(id);
    expect(row.status).toBe("open");
    expect(row.currentStageName).toBe("验收");

    // No activity rows were written for either noop call.
    const activities = await fetchActivities(id);
    expect(activities).toHaveLength(0);
  });
});

// ============================================================================
// T-F3-11: 人工纠错回退留痕
// ============================================================================

describe("T-F3-11: 人工纠错回退留痕", () => {
  it("human+reason target='实施' from '测试' succeeds; activity row is transition.manual-override", async () => {
    const id = await insertItem({ currentStageName: "测试", status: "open" });

    const result = await asUser(() =>
      transitionWorkItem.run(
        { id, target: "实施", reason: "测试发现设计缺陷,退回实施重做" },
        ctxFor("frontend"),
      ),
    );
    expect(result.noop).toBe(false);

    const row = await fetchItem(id);
    expect(row.currentStageName).toBe("实施");

    const activities = await fetchActivities(id);
    expect(activities).toHaveLength(1);
    expect(activities[0]!.eventType).toBe("transition.manual-override");
    expect(activities[0]!.actorKind).toBe("human");
  });
});

// ============================================================================
// T-F3-08: allowedTransitions 同源 (get-work-item 与 guard 纯函数集合逐项相等)
// ============================================================================

describe("T-F3-08: allowedTransitions 同源(前后端不漂移)", () => {
  it("get-work-item's allowedTransitions for a human caller matches the guard's own allowedTransitions() for the same fixture", async () => {
    const { allowedTransitions } = await import("../../server/lib/transition-guard.js");
    const id = await insertItem({ currentStageName: "测试", status: "open", execState: "dispatched" });

    const detail = await asUser(() => getWorkItem.run({ id }, ctxFor("frontend")));
    const guardSide = allowedTransitions(
      { currentStageName: "测试", status: "open", execState: "dispatched" },
      { kind: "human", email: OWNER },
    );

    expect(detail.allowedTransitions).toEqual(guardSide);
  });

  it("agent (tool) caller gets an empty allowedTransitions set", async () => {
    const id = await insertItem({ currentStageName: "测试", status: "open", execState: "dispatched" });
    const detail = await asUser(() => getWorkItem.run({ id }, ctxFor("tool")));
    expect(detail.allowedTransitions).toEqual([]);
  });
});

// ============================================================================
// T-F3-15: 并发流转竞态 (CAS)
// ============================================================================

describe("T-F3-15: 并发流转竞态(CAS)", () => {
  it("two concurrent transitions from the same source snapshot — exactly one wins, the other is rejected as a conflict, no double-apply", async () => {
    // 验收(待人工评审) source: both target=done (full evidence) and target=实施
    // (manual-override rollback) are independently legal from this state.
    const id = await insertItem({ currentStageName: "验收", status: "open", execState: "dispatched" });

    const callA = asUser(() =>
      transitionWorkItem.run(
        {
          id,
          target: "done",
          reason: "评审通过,合入完成",
          verdict: "PASSED",
          evidence: { commit: "abcdef1" },
        },
        ctxFor("frontend"),
      ),
    );
    const callB = asUser(() =>
      transitionWorkItem.run(
        { id, target: "实施", reason: "并发同时发起的回退" },
        ctxFor("frontend"),
      ),
    );

    const results = await Promise.allSettled([callA, callB]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly one succeeded, one was rejected as a conflict.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const row = await fetchItem(id);
    // The terminal state is EXACTLY the winner's — either done, or 实施 —
    // never a mix of both (no double-apply).
    const wonDone = row.status === "done";
    const wonRollback = row.currentStageName === "实施" && row.status === "open";
    expect(wonDone || wonRollback).toBe(true);
    expect(wonDone && wonRollback).toBe(false);

    // Exactly one activity row was written — the loser's write never reached
    // the activity insert (it threw before that point).
    const activities = await fetchActivities(id);
    expect(activities).toHaveLength(1);
  });
});

// ============================================================================
// T-F6-06: done 守卫钩 —— 核对清单未全不得批准(服务端)
//
// docs/sdlc-impl-f5-f10.md §2E T-F6-06: 钩点 actions/transition-work-item.ts
// 的 effectiveTarget==='done' 分支(assertTransition 通过后、patch.status=
// 'done' 写入前)—— checklist 有未确认项时人工 transition done(证据齐) →
// evidence-missing need 含 'checklist';全确认后同调用成功。
//
// The always-present "ownerScope 贯穿新查询" checklist item (server/lib/
// review-checklist.ts's `assembleChecklist`) is what makes this reachable
// without needing a diff or nature='数据' fixture — it applies to every work
// item once a review artifact is anchored, and is never auto-confirmed.
// ============================================================================

describe("T-F6-06: done 守卫钩(评审核对清单未全不得批准)", () => {
  async function insertSprint(id: string) {
    const now = new Date().toISOString();
    await db.insert(trackerSchema.sprints).values({
      id,
      projectId: "proj-1",
      name: "Sprint F6",
      goal: "",
      status: "进行中",
      phase: "executing",
      startDate: "",
      endDate: "",
      createdAt: now,
      updatedAt: now,
      ownerEmail: OWNER,
      orgId: ORG_ID,
    });
  }

  async function insertReviewAnchor(sprintId: string, workItemId: string) {
    const now = new Date().toISOString();
    const artifactId = `art_${workItemId}`;
    await db.insert(trackerSchema.sprintArtifacts).values({
      id: artifactId,
      sprintId,
      docKey: `review:${workItemId}`,
      kind: "代码变更",
      name: "评审核对清单锚点",
      version: 1,
      producedByKind: "agent",
      content: "",
      createdAt: now,
      ownerEmail: OWNER,
      orgId: ORG_ID,
    });
    return artifactId;
  }

  it("锚定评审产物但核对清单未确认(ownerScope 贯穿新查询未勾)→ done 被拒 evidence-missing need=['checklist'],状态不变", async () => {
    await insertSprint("sprint-f6-1");
    const id = await insertItem({
      currentStageName: "验收",
      status: "open",
      execState: "returned",
      sprintId: "sprint-f6-1",
    });
    await insertReviewAnchor("sprint-f6-1", id);

    let caught: (Error & { code?: string; need?: string[] }) | undefined;
    try {
      await asUser(() =>
        transitionWorkItem.run(
          {
            id,
            target: "done",
            reason: "评审通过,合并完成",
            verdict: "PASSED",
            evidence: { commit: "abcdef1234" },
          },
          ctxFor("frontend"),
        ),
      );
    } catch (err) {
      caught = err as Error & { code?: string; need?: string[] };
    }
    expect(caught).toBeDefined();
    expect(caught!.code).toBe("evidence-missing");
    expect(caught!.need).toEqual(["checklist"]);

    const row = await fetchItem(id);
    expect(row.status).toBe("open"); // NOT done — zero state residue
  });

  it("确认全部核对项(ownerscope-check checked=1)后 → 同一调用成功落 done", async () => {
    await insertSprint("sprint-f6-2");
    const id = await insertItem({
      currentStageName: "验收",
      status: "open",
      execState: "returned",
      sprintId: "sprint-f6-2",
    });
    const artifactId = await insertReviewAnchor("sprint-f6-2", id);

    // Human confirms the one applicable checklist item directly via the
    // reused B5 persistence shape (reviewKey namespace checklist:<key>) —
    // mirrors what the real S5 card would do through set-artifact-review.
    const now = new Date().toISOString();
    await db.insert(trackerSchema.artifactReviews).values({
      id: `rev_${id}_ownerscope`,
      artifactId,
      version: 1,
      reviewKey: "checklist:ownerscope-check",
      checked: 1,
      reviewer: OWNER,
      createdAt: now,
      updatedAt: now,
      ownerEmail: OWNER,
      orgId: ORG_ID,
    });

    const result = await asUser(() =>
      transitionWorkItem.run(
        {
          id,
          target: "done",
          reason: "评审通过,合并完成",
          verdict: "PASSED",
          evidence: { commit: "abcdef1234" },
        },
        ctxFor("frontend"),
      ),
    );
    expect(result.noop).toBe(false);
    expect(result.status).toBe("done");

    const row = await fetchItem(id);
    expect(row.status).toBe("done");
  });

  it("没有 sprintId 且从未渲染评审(合成锚点零行)→ 守卫放行,done 通过(F-3:sprint 外项未渲染=未评审→放行,不锁死)", async () => {
    const id = await insertItem({
      currentStageName: "验收",
      status: "open",
      execState: "returned",
      sprintId: null,
    });

    const result = await asUser(() =>
      transitionWorkItem.run(
        {
          id,
          target: "done",
          reason: "评审通过,合并完成(无 sprint 绑定)",
          verdict: "PASSED",
          evidence: { commit: "abcdef1234" },
        },
        ctxFor("frontend"),
      ),
    );
    expect(result.noop).toBe(false);
    expect(result.status).toBe("done");
  });

  // ── F-3: sprint 外项一旦渲染(合成锚点有行)→ 门有牙 ──────────────────────
  it("没有 sprintId 但已渲染评审(合成锚点有未确认行)→ done 被拒(F-3 门对 sprint 外项也有牙)", async () => {
    const id = await insertItem({
      currentStageName: "验收",
      status: "open",
      execState: "returned",
      sprintId: null,
    });
    // Simulate a rendered-but-unconfirmed review on the synthetic anchor:
    // one human placeholder persisted at checked=0.
    const now = new Date().toISOString();
    await db.insert(trackerSchema.artifactReviews).values({
      id: `rev_${id}_syn`,
      artifactId: `wi-review:${id}`,
      version: 1,
      reviewKey: "checklist:ownerscope-check",
      checked: 0,
      reviewer: "system",
      createdAt: now,
      updatedAt: now,
      ownerEmail: OWNER,
      orgId: ORG_ID,
    });

    let caught: (Error & { code?: string; need?: string[] }) | undefined;
    try {
      await asUser(() =>
        transitionWorkItem.run(
          {
            id,
            target: "done",
            reason: "尝试跳过 sprint 外项评审",
            verdict: "PASSED",
            evidence: { commit: "abcdef1234" },
          },
          ctxFor("frontend"),
        ),
      );
    } catch (err) {
      caught = err as Error & { code?: string; need?: string[] };
    }
    expect(caught?.code).toBe("evidence-missing");
    expect(caught?.need).toEqual(["checklist"]);
    const row = await fetchItem(id);
    expect(row.status).toBe("open");
  });

  // ── F-1 回归:守卫死锁根治(这条在只读修复前会红:旧守卫走写路径,无 diff
  // 下把机器项 migration-smoke-evidence 重算为 needs-human → 覆盖回 0 → done
  // 永拒 + 机器行被打回 0)──────────────────────────────────────────────────
  it("F-1 回归:nature=['数据']、机器项+人工项全确认=1 → 守卫(无 diff 只读)放行,且绝不把机器项打回 0", async () => {
    await insertSprint("sprint-f6-3");
    const id = await insertItem({
      currentStageName: "验收",
      status: "open",
      execState: "returned",
      sprintId: "sprint-f6-3",
      nature: JSON.stringify(["数据"]),
    });
    const artifactId = await insertReviewAnchor("sprint-f6-3", id);

    // Persist the full data-nature review set all confirmed=1, exactly as a
    // completed S5 review render would: two machine items (migration-audit +
    // migration-smoke-evidence) + one human item (ownerscope-check).
    const now = new Date().toISOString();
    for (const key of [
      "migration-audit",
      "migration-smoke-evidence",
      "ownerscope-check",
    ]) {
      await db.insert(trackerSchema.artifactReviews).values({
        id: `rev_${id}_${key}`,
        artifactId,
        version: 1,
        reviewKey: `checklist:${key}`,
        checked: 1,
        reviewer: key === "ownerscope-check" ? OWNER : "system",
        createdAt: now,
        updatedAt: now,
        ownerEmail: OWNER,
        orgId: ORG_ID,
      });
    }

    const result = await asUser(() =>
      transitionWorkItem.run(
        {
          id,
          target: "done",
          reason: "评审通过,合并完成",
          verdict: "PASSED",
          evidence: { commit: "abcdef1234" },
        },
        ctxFor("frontend"),
      ),
    );
    // Guard放行 (deadlock gone).
    expect(result.status).toBe("done");

    // Read-only guard: every checklist row is STILL 1 — the machine items were
    // NOT recomputed-and-overwritten back to 0 (the F-1 deadlock's signature).
    const rows = await db
      .select()
      .from(trackerSchema.artifactReviews)
      .where(eq(trackerSchema.artifactReviews.artifactId, artifactId));
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.checked, `${r.reviewKey} must stay confirmed`).toBe(1);
    }
  });
});
