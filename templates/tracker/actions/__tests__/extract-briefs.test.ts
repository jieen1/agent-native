import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { createClient, type Client } from "@libsql/client";
import { eq, and } from "drizzle-orm";
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
let extractBriefs: AnyAction;
let createSprintArtifact: AnyAction;

const OWNER = "owner@example.com";
const ORG_ID = "org-r4b1";

function asUser(fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: OWNER, orgId: ORG_ID }, fn);
}

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "extract-briefs-"));
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
    CREATE TABLE tracker_activities (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      actor_kind TEXT DEFAULT 'agent',
      actor_name TEXT DEFAULT '智能体',
      event_type TEXT NOT NULL,
      payload TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      owner_email TEXT NOT NULL,
      org_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
    );
  `);

  const extractBriefsModule = await import("../extract-briefs.js");
  const createSprintArtifactModule =
    await import("../create-sprint-artifact.js");
  extractBriefs = extractBriefsModule.default as unknown as AnyAction;
  createSprintArtifact =
    createSprintArtifactModule.default as unknown as AnyAction;
}, 30_000);

afterAll(() => {
  client?.close();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.executeMultiple(`
    DELETE FROM tracker_activities;
    DELETE FROM tracker_approvals;
    DELETE FROM tracker_sprint_artifacts;
    DELETE FROM tracker_work_items;
    DELETE FROM tracker_sprints;
    DELETE FROM tracker_projects;
  `);
  await db.insert(trackerSchema.projects).values({
    id: "proj-1",
    key: "PRJ",
    name: "R4b1 Project",
    description: "",
    gitRemote: "git@example.com:prj.git",
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ownerEmail: OWNER,
    orgId: ORG_ID,
  });
  await db.insert(trackerSchema.sprints).values({
    id: "sprint-1",
    projectId: "proj-1",
    name: "Sprint 1",
    goal: "",
    status: "进行中",
    phase: "designing",
    startDate: "",
    endDate: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ownerEmail: OWNER,
    orgId: ORG_ID,
  });
});

async function insertWorkItem(itemKey: string, description = "") {
  const now = new Date().toISOString();
  const id = `wi-${itemKey}`;
  await db.insert(trackerSchema.workItems).values({
    id,
    projectId: "proj-1",
    type: "task",
    title: itemKey,
    description,
    status: "open",
    priority: 1,
    createdAt: now,
    updatedAt: now,
    ownerEmail: OWNER,
    orgId: ORG_ID,
    sprintId: "sprint-1",
    itemKey,
    currentStageName: "设计",
  });
  return id;
}

const TECH_DESIGN = `# Sprint 1 技术设计

## §2 约定

统一命名约定。

## §4 工作项设计

### §4.1 PRJ-001 · 队列重排序

- **依赖**: 无

实现 exec_queue.position 持久化。

### §4.2 PRJ-002 · 超时提醒

- **依赖**: PRJ-001

读取排序结果计算 ETA。

## §5 数据模型

exec_queue 增加 position 列。

## §6 API 表

| 方法 | 路径 | 生产方 | 消费方 | 说明 |
| --- | --- | --- | --- | --- |
| GET | /api/queue/eta | PRJ-001 | PRJ-002 | 返回预计等待时间 |

## §7 文件变更矩阵

| 文件路径 | 操作 | 所属工作项 | 说明 | 依赖文件 |
| --- | --- | --- | --- | --- |
| \`actions/reorder-queue.ts\` | MODIFY | PRJ-001 | 持久化顺序 | |
| \`actions/get-queue-eta.ts\` | CREATE | PRJ-002 | 计算 ETA | \`actions/reorder-queue.ts\` |

## §8 测试策略

黑盒覆盖。

### Env Vars

- \`QUEUE_ETA_TTL_MS\`: 缓存 TTL
`;

async function seedTechDesign(content = TECH_DESIGN) {
  return asUser(() =>
    createSprintArtifact.run({
      sprintId: "sprint-1",
      docKey: "tech-design",
      kind: "设计",
      name: "技术设计",
      content,
    }),
  );
}

async function approveDesignSignoff(
  anchorArtifactId: string,
  anchorVersion: number,
) {
  await db.insert(trackerSchema.approvals).values({
    id: `appr-${anchorArtifactId}`,
    sprintId: "sprint-1",
    gateKey: "design-signoff",
    status: "approved",
    requestedBy: OWNER,
    anchorArtifactId,
    anchorVersion,
    createdAt: new Date().toISOString(),
    decidedAt: new Date().toISOString(),
    decidedBy: OWNER,
    ownerEmail: OWNER,
    orgId: ORG_ID,
  });
}

describe("extract-briefs — design-signoff gate", () => {
  it("refuses without an approved design-signoff and without force", async () => {
    await insertWorkItem("PRJ-001");
    await insertWorkItem("PRJ-002");
    const td = await seedTechDesign();

    await expect(
      asUser(() => extractBriefs.run({ sprintId: "sprint-1" })),
    ).rejects.toThrow(/design-signoff/);
    void td;
  });

  it("proceeds with force=true and leaves a visible trace in briefs-index", async () => {
    await insertWorkItem("PRJ-001");
    await insertWorkItem("PRJ-002");
    await seedTechDesign();

    const result = await asUser(() =>
      extractBriefs.run({ sprintId: "sprint-1", force: true }),
    );
    expect(result.designSignoffApproved).toBe(false);
    expect(result.forced).toBe(true);

    const indexRow = (
      await db
        .select()
        .from(trackerSchema.sprintArtifacts)
        .where(eq(trackerSchema.sprintArtifacts.id, result.briefsIndex.id))
    )[0]!;
    expect(indexRow.content).toContain("强制提取留痕");
  });

  it("proceeds without force once design-signoff is approved for the current version", async () => {
    await insertWorkItem("PRJ-001");
    await insertWorkItem("PRJ-002");
    const td = await seedTechDesign();
    await approveDesignSignoff(td.id, td.version);

    const result = await asUser(() =>
      extractBriefs.run({ sprintId: "sprint-1" }),
    );
    expect(result.designSignoffApproved).toBe(true);
    expect(result.forced).toBe(false);
  });
});

describe("extract-briefs — brief/shared-brief/briefs-index generation", () => {
  it("produces one brief per §4 item, a shared-brief, and a briefs-index with correct Wave order + dependencies", async () => {
    await insertWorkItem("PRJ-001");
    await insertWorkItem("PRJ-002");
    const td = await seedTechDesign();
    await approveDesignSignoff(td.id, td.version);

    const result = await asUser(() =>
      extractBriefs.run({ sprintId: "sprint-1" }),
    );

    expect(result.briefs).toHaveLength(2);
    const byKey = Object.fromEntries(
      result.briefs.map((b: any) => [b.itemKey, b]),
    );
    expect(byKey["PRJ-001"]).toBeDefined();
    expect(byKey["PRJ-002"]).toBeDefined();
    expect(byKey["PRJ-001"].skipped).toBe(false);

    expect(result.sharedBrief.skipped).toBe(false);
    expect(result.briefsIndex.waves).toEqual([["PRJ-001"], ["PRJ-002"]]);
    expect(result.briefsIndex.missingItems).toEqual([]);
    expect(
      result.briefsIndex.dependencies.some(
        (e: any) => e.itemKey === "PRJ-002" && e.dependsOn === "PRJ-001",
      ),
    ).toBe(true);

    const briefRow = (
      await db
        .select()
        .from(trackerSchema.sprintArtifacts)
        .where(eq(trackerSchema.sprintArtifacts.docKey, "brief:PRJ-001"))
    )[0]!;
    expect(briefRow.content).toContain("exec_queue.position");

    const sharedRow = (
      await db
        .select()
        .from(trackerSchema.sprintArtifacts)
        .where(eq(trackerSchema.sprintArtifacts.docKey, "shared-brief"))
    )[0]!;
    expect(sharedRow.content).toContain("QUEUE_ETA_TTL_MS");
    expect(sharedRow.content).not.toContain("§4 工作项设计");
  });

  it("reports missing items referenced by §7/§6 but with no §4 section", async () => {
    await insertWorkItem("PRJ-001");
    await insertWorkItem("PRJ-002");
    const withMissing = TECH_DESIGN.replace(
      "| GET | /api/queue/eta | PRJ-001 | PRJ-002 | 返回预计等待时间 |",
      "| GET | /api/queue/eta | PRJ-001 | PRJ-002 | 返回预计等待时间 |\n| POST | /api/queue/notify | PRJ-999 | PRJ-002 | 通知渠道 |",
    );
    const td = await seedTechDesign(withMissing);
    await approveDesignSignoff(td.id, td.version);

    const result = await asUser(() =>
      extractBriefs.run({ sprintId: "sprint-1" }),
    );
    expect(result.briefsIndex.missingItems).toEqual(["PRJ-999"]);
  });

  it("throws a clear error listing the edges when the dependency graph has a cycle", async () => {
    await insertWorkItem("PRJ-001");
    await insertWorkItem("PRJ-002");
    const cyclic = TECH_DESIGN.replace("- **依赖**: 无", "- **依赖**: PRJ-002");
    const td = await seedTechDesign(cyclic);
    await approveDesignSignoff(td.id, td.version);

    await expect(
      asUser(() => extractBriefs.run({ sprintId: "sprint-1" })),
    ).rejects.toThrow(/环/);
  });
});

describe("extract-briefs — idempotency", () => {
  it("skips creating a new version when content is unchanged, and creates one when it changes", async () => {
    await insertWorkItem("PRJ-001");
    await insertWorkItem("PRJ-002");
    const td = await seedTechDesign();
    await approveDesignSignoff(td.id, td.version);

    const first = await asUser(() =>
      extractBriefs.run({ sprintId: "sprint-1" }),
    );
    expect(first.briefs.every((b: any) => b.skipped === false)).toBe(true);
    expect(first.sharedBrief.skipped).toBe(false);
    expect(first.briefsIndex.skipped).toBe(false);

    const second = await asUser(() =>
      extractBriefs.run({ sprintId: "sprint-1" }),
    );
    expect(second.briefs.every((b: any) => b.skipped === true)).toBe(true);
    expect(second.sharedBrief.skipped).toBe(true);
    // briefs-index differs only if content changes — unchanged inputs → unchanged index too.
    expect(second.briefsIndex.skipped).toBe(true);

    const briefRows = await db
      .select()
      .from(trackerSchema.sprintArtifacts)
      .where(
        and(
          eq(trackerSchema.sprintArtifacts.sprintId, "sprint-1"),
          eq(trackerSchema.sprintArtifacts.docKey, "brief:PRJ-001"),
        ),
      );
    expect(briefRows).toHaveLength(1); // no duplicate version created

    // Now change the tech-design content (new §4.1 body) and re-approve a fresh signoff.
    const changed = TECH_DESIGN.replace("持久化。", "持久化，新增乐观锁字段。");
    const td2 = await seedTechDesign(changed);
    await approveDesignSignoff(td2.id, td2.version);

    const third = await asUser(() =>
      extractBriefs.run({ sprintId: "sprint-1" }),
    );
    const changedBrief = third.briefs.find((b: any) => b.itemKey === "PRJ-001");
    expect(changedBrief.skipped).toBe(false);

    const briefRowsAfter = await db
      .select()
      .from(trackerSchema.sprintArtifacts)
      .where(
        and(
          eq(trackerSchema.sprintArtifacts.sprintId, "sprint-1"),
          eq(trackerSchema.sprintArtifacts.docKey, "brief:PRJ-001"),
        ),
      );
    expect(briefRowsAfter).toHaveLength(2); // v2 created for the changed brief only
  });
});

describe("extract-briefs — scale flagging", () => {
  it("flags a brief as split-required and writes back the work item's scaleEstimate", async () => {
    await insertWorkItem("PRJ-001");
    await insertWorkItem("PRJ-002");
    // Cross more than 6 file references into §4.1's body so estimateScale flags it.
    const manyFiles = Array.from(
      { length: 7 },
      (_, i) => `\`server/lib/file-${i}.ts\``,
    ).join("、");
    const bigBody = TECH_DESIGN.replace(
      "实现 exec_queue.position 持久化。",
      `实现 exec_queue.position 持久化，涉及 ${manyFiles}。`,
    );
    const td = await seedTechDesign(bigBody);
    await approveDesignSignoff(td.id, td.version);

    const result = await asUser(() =>
      extractBriefs.run({ sprintId: "sprint-1" }),
    );
    const flagged = result.briefs.find((b: any) => b.itemKey === "PRJ-001");
    expect(flagged.scaleFlagged).toBe(true);
    expect(flagged.scaleVerdict).toBe("split-required");
    expect(result.scaleWarnings.some((w: any) => w.itemKey === "PRJ-001")).toBe(
      true,
    );

    const row = (
      await db
        .select()
        .from(trackerSchema.workItems)
        .where(eq(trackerSchema.workItems.id, "wi-PRJ-001"))
    )[0]!;
    const scaleEstimate = JSON.parse(row.scaleEstimate as string);
    expect(scaleEstimate.verdict).toBe("split-required");
  });

  it("does not flag a small, single-file brief", async () => {
    await insertWorkItem("PRJ-001");
    await insertWorkItem("PRJ-002");
    const td = await seedTechDesign();
    await approveDesignSignoff(td.id, td.version);

    const result = await asUser(() =>
      extractBriefs.run({ sprintId: "sprint-1" }),
    );
    const notFlagged = result.briefs.find((b: any) => b.itemKey === "PRJ-001");
    expect(notFlagged.scaleFlagged).toBe(false);
  });
});
