import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { createClient, type Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as trackerSchema from "../../server/db/schema.js";

let client: Client;
let db: LibSQLDatabase<typeof trackerSchema>;
let dbDir: string;

vi.mock("../../server/db/index.js", () => ({
  getDb: () => db,
  schema: trackerSchema,
}));

type AnyAction = { run: (args: any) => Promise<any> };
let getReviewChecklist: AnyAction;
let createSprintArtifact: AnyAction;
let setArtifactReview: AnyAction;

const OWNER = "owner@example.com";
const ORG_ID = "org-f6";

function asUser(fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: OWNER, orgId: ORG_ID }, fn);
}

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "get-review-checklist-"));
  client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
  db = drizzle(client, { schema: trackerSchema });

  await client.executeMultiple(`
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
    CREATE TABLE tracker_approvals (
      id TEXT PRIMARY KEY,
      sprint_id TEXT NOT NULL,
      work_item_id TEXT,
      gate_key TEXT NOT NULL,
      gate_ref TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_by TEXT NOT NULL,
      decided_by TEXT,
      reason TEXT,
      decided_at TEXT,
      anchor_artifact_id TEXT,
      anchor_version INTEGER,
      stale_at TEXT,
      created_at TEXT NOT NULL,
      owner_email TEXT NOT NULL,
      org_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
    );
  `);

  const getReviewChecklistModule = await import("../get-review-checklist.js");
  const createSprintArtifactModule = await import("../create-sprint-artifact.js");
  const setArtifactReviewModule = await import("../set-artifact-review.js");
  getReviewChecklist = getReviewChecklistModule.default as unknown as AnyAction;
  createSprintArtifact = createSprintArtifactModule.default as unknown as AnyAction;
  setArtifactReview = setArtifactReviewModule.default as unknown as AnyAction;
}, 30_000);

afterAll(() => {
  client?.close();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.executeMultiple(`
    DELETE FROM tracker_artifact_reviews;
    DELETE FROM tracker_sprint_artifacts;
    DELETE FROM tracker_approvals;
    DELETE FROM tracker_sprints;
    DELETE FROM tracker_work_items;
    DELETE FROM tracker_projects;
  `);
  await db.insert(trackerSchema.projects).values({
    id: "proj-1",
    key: "F6",
    name: "F6 Project",
    description: "",
    gitRemote: "git@example.com:f6.git",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ownerEmail: OWNER,
    orgId: ORG_ID,
  });
});

async function insertSprint(id: string) {
  const now = new Date().toISOString();
  await db.insert(trackerSchema.sprints).values({
    id,
    projectId: "proj-1",
    name: "Sprint",
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
    itemKey: "F6-1",
    currentStageName: "验收",
    ...overrides,
  });
  return id;
}

// ============================================================================
// T-F6-02: 重放 B5 场景 —— schema 加表、迁移不加的 diff → get-review-checklist
// docs/sdlc-impl-f5-f10.md §2E: "机器项 state='fail' 且缺失表名=
// tracker_artifact_reviews 式精确名单"
// ============================================================================

describe("T-F6-02: 重放 B5 场景(防住 SDLC-061)", () => {
  const DIFF_SCHEMA_ADDS_TABLE_NO_MIGRATION = `
diff --git a/templates/tracker/server/db/schema.ts b/templates/tracker/server/db/schema.ts
--- a/templates/tracker/server/db/schema.ts
+++ b/templates/tracker/server/db/schema.ts
@@ -330,3 +330,13 @@
+export const artifactReviews = table(
+  "tracker_artifact_reviews",
+  {
+    id: text("id").primaryKey(),
+  },
+);
`;

  it("diff 显示 schema 新增 tracker_artifact_reviews 表但没有对应迁移 → migration-audit 机器项 state='fail',detail 精确命中该表名", async () => {
    const id = await insertItem({ sprintId: null, nature: "[]" });

    const result = await asUser(() =>
      getReviewChecklist.run({ workItemId: id, diff: DIFF_SCHEMA_ADDS_TABLE_NO_MIGRATION }),
    );

    const migrationItem = result.items.find((i: any) => i.key === "migration-audit");
    expect(migrationItem).toBeDefined();
    expect(migrationItem.state).toBe("fail");
    expect(migrationItem.detail).toBe("tracker_artifact_reviews");
  });

  it("同一张表若 diff 也带上对应迁移 → migration-audit 机器项 state='pass'", async () => {
    const id = await insertItem({ sprintId: null, nature: "[]" });
    const diffWithMigration =
      DIFF_SCHEMA_ADDS_TABLE_NO_MIGRATION +
      `
diff --git a/templates/tracker/server/plugins/db.ts b/templates/tracker/server/plugins/db.ts
+      sql: \`CREATE TABLE IF NOT EXISTS tracker_artifact_reviews (id TEXT PRIMARY KEY)\`,
`;
    const result = await asUser(() =>
      getReviewChecklist.run({ workItemId: id, diff: diffWithMigration }),
    );
    const migrationItem = result.items.find((i: any) => i.key === "migration-audit");
    expect(migrationItem.state).toBe("pass");
    expect(migrationItem.detail).toBeUndefined();
  });
});

// ============================================================================
// T-F6-07: 核对清单持久化 + 重置 —— 状态锚定产物版本
// docs/sdlc-impl-f5-f10.md §2E: "勾选两项→重读;create-sprint-artifact 出新
// 版本→重读 | 重读还原;新版本后全部回到未确认"
// ============================================================================

describe("T-F6-07: 核对清单持久化 + 重置(锚定 sprint 产物版本)", () => {
  // A diff with ≥2 distinct schema.X insert/update call sites — triggers the
  // 'transaction-wrap' human item (no schema change, so the two migration
  // items stay out of scope — keeps the fixture to exactly the two
  // confirmable human items "勾选两项" refers to).
  const MULTI_TABLE_WRITE_DIFF = `
diff --git a/templates/tracker/actions/example.ts b/templates/tracker/actions/example.ts
+  await db.insert(schema.exportJobs).values({ id });
+  await db.update(schema.activities).set({ eventType: "export.done" });
`;

  it("F-2 惰性建锚 + 勾选两项 → 重读还原;create-sprint-artifact 出新版本 → 重读全部回到未确认", async () => {
    await insertSprint("sprint-1");
    const id = await insertItem({ sprintId: "sprint-1", nature: "[]" });

    // F-2: get-review-checklist LAZILY creates the review anchor — no prior
    // create-sprint-artifact call. (Before F-2 this returned artifactId=null
    // and the gate spun empty — SDLC-061 wasn't closed in the running system.)
    const first = await asUser(() =>
      getReviewChecklist.run({ workItemId: id, diff: MULTI_TABLE_WRITE_DIFF }),
    );
    expect(first.artifactId).not.toBeNull();
    expect(first.version).toBe(1);
    const anchorId = first.artifactId as string;
    const keys = first.items.map((i: any) => i.key).sort();
    expect(keys).toEqual(["ownerscope-check", "transaction-wrap"]);
    expect(first.items.every((i: any) => i.checked === false)).toBe(true);
    expect(first.complete).toBe(false);

    // 勾选两项.
    await asUser(() =>
      setArtifactReview.run({
        artifactId: anchorId,
        version: 1,
        reviewKey: "checklist:transaction-wrap",
        checked: true,
      }),
    );
    await asUser(() =>
      setArtifactReview.run({
        artifactId: anchorId,
        version: 1,
        reviewKey: "checklist:ownerscope-check",
        checked: true,
      }),
    );

    // 重读还原.
    const second = await asUser(() =>
      getReviewChecklist.run({ workItemId: id, diff: MULTI_TABLE_WRITE_DIFF }),
    );
    expect(second.artifactId).toBe(anchorId); // idempotent — no second anchor
    expect(second.items.every((i: any) => i.checked === true)).toBe(true);
    expect(second.complete).toBe(true);

    // create-sprint-artifact 出新版本(v2)→ 重置. Real delivery-redo path
    // (the lazy helper only creates v1 when none exists; version bumps come
    // from the real action, per this module's docblock).
    const bumped = await asUser(() =>
      createSprintArtifact.run({
        sprintId: "sprint-1",
        docKey: `review:${id}`,
        kind: "评审",
        name: "评审核对清单锚点 v2",
      }),
    );
    expect(bumped.version).toBe(2);
    expect(bumped.id).not.toBe(anchorId); // new artifact row → naturally orphans old reviews

    const third = await asUser(() =>
      getReviewChecklist.run({ workItemId: id, diff: MULTI_TABLE_WRITE_DIFF }),
    );
    expect(third.artifactId).toBe(bumped.id);
    expect(third.version).toBe(2);
    expect(third.items.every((i: any) => i.checked === false)).toBe(true);
    expect(third.complete).toBe(false);
  });

  it("F-2 惰性建锚幂等:连调两次 get-review-checklist 不重复建锚(仍 v1,同一 artifactId)", async () => {
    await insertSprint("sprint-2");
    const id = await insertItem({ sprintId: "sprint-2", nature: "[]" });

    const r1 = await asUser(() =>
      getReviewChecklist.run({ workItemId: id, diff: MULTI_TABLE_WRITE_DIFF }),
    );
    const r2 = await asUser(() =>
      getReviewChecklist.run({ workItemId: id, diff: MULTI_TABLE_WRITE_DIFF }),
    );
    expect(r1.artifactId).not.toBeNull();
    expect(r2.artifactId).toBe(r1.artifactId);
    expect(r2.version).toBe(1);

    // Exactly one sprint artifact row was created for this review docKey.
    const rows = await db
      .select()
      .from(trackerSchema.sprintArtifacts)
      .where(eq(trackerSchema.sprintArtifacts.docKey, `review:${id}`));
    expect(rows).toHaveLength(1);
  });

  it("F-3 sprint 外项(无 sprintId)→ 合成锚点 wi-review:<id>,门可持久化(不空转)", async () => {
    const id = await insertItem({ sprintId: null, nature: "[]" });

    const r = await asUser(() =>
      getReviewChecklist.run({ workItemId: id, diff: MULTI_TABLE_WRITE_DIFF }),
    );
    // Synthetic deterministic anchor — no sprint artifact row exists.
    expect(r.artifactId).toBe(`wi-review:${id}`);
    expect(r.version).toBe(1);
    expect(r.items.every((i: any) => i.checked === false)).toBe(true);
    expect(r.complete).toBe(false);
    const sprintRows = await db
      .select()
      .from(trackerSchema.sprintArtifacts)
      .where(eq(trackerSchema.sprintArtifacts.docKey, `review:${id}`));
    expect(sprintRows).toHaveLength(0); // no sprint artifact created for sprint-less items

    // Persistence works against the synthetic anchor — the gate has teeth.
    await asUser(() =>
      setArtifactReview.run({
        artifactId: `wi-review:${id}`,
        version: 1,
        reviewKey: "checklist:transaction-wrap",
        checked: true,
      }),
    );
    await asUser(() =>
      setArtifactReview.run({
        artifactId: `wi-review:${id}`,
        version: 1,
        reviewKey: "checklist:ownerscope-check",
        checked: true,
      }),
    );
    const r2 = await asUser(() =>
      getReviewChecklist.run({ workItemId: id, diff: MULTI_TABLE_WRITE_DIFF }),
    );
    expect(r2.complete).toBe(true);
  });
});
