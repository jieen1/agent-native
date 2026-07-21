import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// ============================================================================
// SDLC-038 回溯去重迁移 (工单 cy9upfianv) — server/lib/item-key-dedupe.ts.
//
// 与 item-key-sequencer.test.ts 相同的约定:applyDedupePlan 内部经
// allocateItemKey() 调用进程级 getDbExec() 单例,所以本文件在首次调用前把
// process.env.DATABASE_URL 指向一个隔离的临时 SQLite 文件,绝不碰模板真实本地库。
//
// 覆盖:computeDedupePlan 的纯函数分组语义(重复 2/3 次、多 key、sprintId 非空
// 不参与、空 itemKey 不参与、无重复返回空),以及 applyDedupePlan 对着临时 SQLite
// 的真实 DB 读写(撞号行拿到全新唯一 key、权威行不变、activities/comments 追加
// 预期条数且含 oldItemKey/newItemKey、重复执行幂等不再产生撞号)。
// ============================================================================

let dbDir: string;
let dbPath: string;
let originalDatabaseUrl: string | undefined;

beforeAll(() => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "item-key-dedupe-"));
  dbPath = path.join(dbDir, "test.db");
  originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = `file:${dbPath}`;
});

afterAll(async () => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  const { closeDbExec } = await import("@agent-native/core/db");
  await closeDbExec?.().catch(() => {});
  fs.rmSync(dbDir, { recursive: true, force: true });
});

async function setup() {
  const { getDbExec } = await import("@agent-native/core/db");
  const exec = getDbExec();
  await exec.execute(
    `CREATE TABLE IF NOT EXISTS tracker_project_seq (project_id TEXT PRIMARY KEY, next_seq INTEGER NOT NULL)`,
  );
  // 与 server/plugins/db.ts 的真实建表 SQL 对齐:ownable 列(owner_email NOT NULL
  // DEFAULT 'local@localhost'、org_id 可空)必须存在——之前的简化建表 schema 漏掉
  // 了这两列,掩盖了 applyDedupePlan 不带 owner_email/org_id 插入的 bug。
  await exec.execute(
    `CREATE TABLE IF NOT EXISTS tracker_work_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      item_key TEXT NOT NULL DEFAULT '',
      sprint_id TEXT,
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      owner_email TEXT NOT NULL DEFAULT 'local@localhost',
      org_id TEXT
    )`,
  );
  await exec.execute(
    `CREATE TABLE IF NOT EXISTS tracker_activities (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      actor_kind TEXT,
      actor_name TEXT,
      event_type TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL,
      owner_email TEXT NOT NULL DEFAULT 'local@localhost',
      org_id TEXT
    )`,
  );
  await exec.execute(
    `CREATE TABLE IF NOT EXISTS tracker_comments (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      author_kind TEXT,
      author_name TEXT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      owner_email TEXT NOT NULL DEFAULT 'local@localhost',
      org_id TEXT
    )`,
  );
  return exec;
}

afterEach(async () => {
  // setup() 建表(CREATE TABLE IF NOT EXISTS)再清空——纯函数测试用例不会建表,
  // 直接 DELETE 会因表不存在而报错。
  const exec = await setup();
  await exec.execute(`DELETE FROM tracker_project_seq`);
  await exec.execute(`DELETE FROM tracker_work_items`);
  await exec.execute(`DELETE FROM tracker_activities`);
  await exec.execute(`DELETE FROM tracker_comments`);
});

type Row = {
  id: string;
  itemKey: string;
  sprintId: string | null;
  createdAt: string;
};

function row(
  id: string,
  itemKey: string,
  createdAt: string,
  sprintId: string | null = null,
): Row {
  return { id, itemKey, sprintId, createdAt };
}

describe("computeDedupePlan", () => {
  it("一个 key 重复 2 次 -> 1 条记录,最早创建者为权威", async () => {
    const { computeDedupePlan } = await import("../item-key-dedupe.js");
    const plan = computeDedupePlan([
      row("b", "SDLC-033", "2024-02-01T00:00:00.000Z"),
      row("a", "SDLC-033", "2024-01-01T00:00:00.000Z"),
    ]);
    expect(plan).toEqual([
      { staleId: "b", oldItemKey: "SDLC-033", authoritativeId: "a" },
    ]);
  });

  it("一个 key 重复 3 次 -> 2 条记录,共享同一个 authoritativeId", async () => {
    const { computeDedupePlan } = await import("../item-key-dedupe.js");
    const plan = computeDedupePlan([
      row("c", "SDLC-034", "2024-03-01T00:00:00.000Z"),
      row("a", "SDLC-034", "2024-01-01T00:00:00.000Z"),
      row("b", "SDLC-034", "2024-02-01T00:00:00.000Z"),
    ]);
    expect(plan).toHaveLength(2);
    const staleIds = plan.map((p) => p.staleId).sort();
    expect(staleIds).toEqual(["b", "c"]);
    for (const p of plan) {
      expect(p.authoritativeId).toBe("a");
      expect(p.oldItemKey).toBe("SDLC-034");
    }
  });

  it("多个不同 key 各自重复 -> 每个 key 各自产生记录", async () => {
    const { computeDedupePlan } = await import("../item-key-dedupe.js");
    const plan = computeDedupePlan([
      row("x1", "SDLC-032", "2024-01-01T00:00:00.000Z"),
      row("x2", "SDLC-032", "2024-01-02T00:00:00.000Z"),
      row("y1", "SDLC-056", "2024-01-03T00:00:00.000Z"),
      row("y2", "SDLC-056", "2024-01-04T00:00:00.000Z"),
    ]);
    expect(plan).toHaveLength(2);
    const byKey = new Map(plan.map((p) => [p.oldItemKey, p]));
    expect(byKey.get("SDLC-032")?.staleId).toBe("x2");
    expect(byKey.get("SDLC-032")?.authoritativeId).toBe("x1");
    expect(byKey.get("SDLC-056")?.staleId).toBe("y2");
    expect(byKey.get("SDLC-056")?.authoritativeId).toBe("y1");
  });

  it("sprintId 非空的行不参与分组", async () => {
    const { computeDedupePlan } = await import("../item-key-dedupe.js");
    const plan = computeDedupePlan([
      row("a", "SDLC-035", "2024-01-01T00:00:00.000Z", "sprint-1"),
      row("b", "SDLC-035", "2024-01-02T00:00:00.000Z", "sprint-1"),
      // 只有下面两行(未挂 sprint)构成撞号
      row("c", "SDLC-035", "2024-01-03T00:00:00.000Z", null),
      row("d", "SDLC-035", "2024-01-04T00:00:00.000Z", ""),
    ]);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.staleId).toBe("d");
    expect(plan[0]!.authoritativeId).toBe("c");
  });

  it("itemKey 为空/blank 的行不参与分组(各自独立)", async () => {
    const { computeDedupePlan } = await import("../item-key-dedupe.js");
    const plan = computeDedupePlan([
      row("a", "", "2024-01-01T00:00:00.000Z"),
      row("b", "", "2024-01-02T00:00:00.000Z"),
      row("c", "   ", "2024-01-03T00:00:00.000Z"),
    ]);
    expect(plan).toEqual([]);
  });

  it("无重复时返回空数组", async () => {
    const { computeDedupePlan } = await import("../item-key-dedupe.js");
    const plan = computeDedupePlan([
      row("a", "SDLC-001", "2024-01-01T00:00:00.000Z"),
      row("b", "SDLC-002", "2024-01-02T00:00:00.000Z"),
    ]);
    expect(plan).toEqual([]);
  });
});

describe("applyDedupePlan (real SQLite DB)", () => {
  async function seedWorkItem(
    exec: Awaited<ReturnType<typeof setup>>,
    id: string,
    projectId: string,
    itemKey: string,
    createdAt: string,
    ownerEmail = "local@localhost",
    orgId: string | null = null,
  ) {
    await exec.execute({
      sql: `INSERT INTO tracker_work_items (id, project_id, item_key, sprint_id, created_at, updated_at, owner_email, org_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        projectId,
        itemKey,
        null,
        createdAt,
        createdAt,
        ownerEmail,
        orgId,
      ],
    });
  }

  it("撞号行拿到全新且唯一的 itemKey,权威行不变,activities/comments 追加预期条数", async () => {
    const exec = await setup();
    const { applyDedupePlan } = await import("../item-key-dedupe.js");

    // 每个 work item 各自有不同的真实 owner_email / org_id,以验证新插入的
    // activities/comments 行继承的是"对应 work item 自己的"所有权,而非任意固定值
    // 或 DB 默认值。
    await seedWorkItem(
      exec,
      "auth",
      "proj-1",
      "SDLC-033",
      "2024-01-01T00:00:00.000Z",
      "auth@corp.com",
      "org-auth",
    );
    await seedWorkItem(
      exec,
      "stale1",
      "proj-1",
      "SDLC-033",
      "2024-01-02T00:00:00.000Z",
      "user1@corp.com",
      "org-1",
    );
    await seedWorkItem(
      exec,
      "stale2",
      "proj-1",
      "SDLC-033",
      "2024-01-03T00:00:00.000Z",
      "user2@corp.com",
      null,
    );

    const plan = [
      { staleId: "stale1", oldItemKey: "SDLC-033", authoritativeId: "auth" },
      { staleId: "stale2", oldItemKey: "SDLC-033", authoritativeId: "auth" },
    ];
    const results = await applyDedupePlan(exec, undefined, {
      projectId: "proj-1",
      projectKey: "SDLC",
      plan,
    });

    expect(results).toHaveLength(2);
    const newKeys = results.map((r) => r.newItemKey);
    // 全新且唯一,且都不是旧的撞号 key
    expect(new Set(newKeys).size).toBe(2);
    for (const k of newKeys) expect(k).not.toBe("SDLC-033");

    // 权威行 itemKey 不变
    const authRow = await exec.execute({
      sql: `SELECT item_key FROM tracker_work_items WHERE id = ?`,
      args: ["auth"],
    });
    expect((authRow.rows[0] as { item_key: string }).item_key).toBe("SDLC-033");

    // 撞号行各自被改成对应的新 key
    for (const r of results) {
      const rowRes = await exec.execute({
        sql: `SELECT item_key FROM tracker_work_items WHERE id = ?`,
        args: [r.staleId],
      });
      expect((rowRes.rows[0] as { item_key: string }).item_key).toBe(
        r.newItemKey,
      );
    }

    // activities:每个 stale 行一条 item-key.reassigned,共 2 条,payload 含 old/new。
    // 且每行的 owner_email/org_id 必须等于对应 stale work item 自己的真实所有权,
    // 而不是 DB 默认值('local@localhost'/NULL)。
    const acts = await exec.execute(
      `SELECT work_item_id, event_type, payload, owner_email, org_id FROM tracker_activities`,
    );
    expect(acts.rows).toHaveLength(2);
    const expectedActOwnership: Record<
      string,
      { owner_email: string; org_id: string | null }
    > = {
      stale1: { owner_email: "user1@corp.com", org_id: "org-1" },
      stale2: { owner_email: "user2@corp.com", org_id: null },
    };
    for (const a of acts.rows as Array<{
      work_item_id: string;
      event_type: string;
      payload: string;
      owner_email: string;
      org_id: string | null;
    }>) {
      expect(a.event_type).toBe("item-key.reassigned");
      const payload = JSON.parse(a.payload);
      expect(payload.oldItemKey).toBe("SDLC-033");
      expect(typeof payload.newItemKey).toBe("string");
      expect(payload.authoritativeWorkItemId).toBe("auth");
      const expected = expectedActOwnership[a.work_item_id]!;
      expect(a.owner_email).toBe(expected.owner_email);
      expect(a.org_id).toBe(expected.org_id);
    }

    // comments:每个 stale 行 1 条 + 权威行 1 条/记录 = 2(stale) + 2(权威) = 4 条。
    // 每行的 owner_email/org_id 必须等于其所在 work item 自己的真实所有权:
    // stale 行上的评论继承 stale 工单的所有权,权威行上的评论继承权威工单的所有权。
    const comments = await exec.execute(
      `SELECT work_item_id, author_kind, body, owner_email, org_id FROM tracker_comments`,
    );
    expect(comments.rows).toHaveLength(4);
    const expectedCommentOwnership: Record<
      string,
      { owner_email: string; org_id: string | null }
    > = {
      stale1: { owner_email: "user1@corp.com", org_id: "org-1" },
      stale2: { owner_email: "user2@corp.com", org_id: null },
      auth: { owner_email: "auth@corp.com", org_id: "org-auth" },
    };
    for (const c of comments.rows as Array<{
      work_item_id: string;
      author_kind: string;
      body: string;
      owner_email: string;
      org_id: string | null;
    }>) {
      const expected = expectedCommentOwnership[c.work_item_id]!;
      expect(c.owner_email).toBe(expected.owner_email);
      expect(c.org_id).toBe(expected.org_id);
    }
    const staleComments = (
      comments.rows as Array<{
        work_item_id: string;
        author_kind: string;
        body: string;
      }>
    ).filter((c) => c.work_item_id === "stale1" || c.work_item_id === "stale2");
    expect(staleComments).toHaveLength(2);
    for (const c of staleComments) {
      expect(c.author_kind).toBe("agent");
      expect(c.body).toContain("SDLC-033"); // oldItemKey
    }
    // 至少有一条 comment 提到新 key
    const allBodies = (comments.rows as Array<{ body: string }>)
      .map((c) => c.body)
      .join("\n");
    for (const k of newKeys) expect(allBodies).toContain(k);
    const authComments = (
      comments.rows as Array<{ work_item_id: string }>
    ).filter((c) => c.work_item_id === "auth");
    expect(authComments).toHaveLength(2);
  });

  it("重复执行 applyDedupePlan 两次不会产生新的撞号(幂等)", async () => {
    const exec = await setup();
    const { applyDedupePlan, computeDedupePlan } =
      await import("../item-key-dedupe.js");

    await seedWorkItem(
      exec,
      "auth",
      "proj-2",
      "SDLC-040",
      "2024-01-01T00:00:00.000Z",
    );
    await seedWorkItem(
      exec,
      "stale",
      "proj-2",
      "SDLC-040",
      "2024-01-02T00:00:00.000Z",
    );

    async function loadRows() {
      const res = await exec.execute({
        sql: `SELECT id, item_key, sprint_id, created_at FROM tracker_work_items WHERE project_id = ?`,
        args: ["proj-2"],
      });
      return (
        res.rows as Array<{
          id: string;
          item_key: string;
          sprint_id: string | null;
          created_at: string;
        }>
      ).map((r) => ({
        id: r.id,
        itemKey: r.item_key,
        sprintId: r.sprint_id,
        createdAt: r.created_at,
      }));
    }

    // 第一次:有 1 条计划,执行后撞号消失
    const plan1 = computeDedupePlan(await loadRows());
    expect(plan1).toHaveLength(1);
    await applyDedupePlan(exec, undefined, {
      projectId: "proj-2",
      projectKey: "SDLC",
      plan: plan1,
    });

    const rowsAfter = await loadRows();
    const keysAfter = rowsAfter.map((r) => r.itemKey);
    expect(new Set(keysAfter).size).toBe(keysAfter.length); // 无撞号

    // 第二次:基于新分配的 itemKey 已不再重复 -> plan 为空,不再写任何变更
    const plan2 = computeDedupePlan(rowsAfter);
    expect(plan2).toEqual([]);
    const actsBefore = await exec.execute(
      `SELECT count(*) as n FROM tracker_activities`,
    );
    await applyDedupePlan(exec, undefined, {
      projectId: "proj-2",
      projectKey: "SDLC",
      plan: plan2,
    });
    const actsAfter = await exec.execute(
      `SELECT count(*) as n FROM tracker_activities`,
    );
    expect((actsAfter.rows[0] as { n: number }).n).toBe(
      (actsBefore.rows[0] as { n: number }).n,
    );
  });
});
