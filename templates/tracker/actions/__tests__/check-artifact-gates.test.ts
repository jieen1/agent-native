import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { createClient, type Client } from "@libsql/client";
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
let checkArtifactGates: AnyAction;
let createSprintArtifact: AnyAction;

const OWNER = "owner@example.com";
const ORG_ID = "org-r4b1";

function asUser(fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: OWNER, orgId: ORG_ID }, fn);
}

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "check-artifact-gates-"));
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
  `);

  const checkArtifactGatesModule = await import("../check-artifact-gates.js");
  const createSprintArtifactModule =
    await import("../create-sprint-artifact.js");
  checkArtifactGates = checkArtifactGatesModule.default as unknown as AnyAction;
  createSprintArtifact =
    createSprintArtifactModule.default as unknown as AnyAction;
}, 30_000);

afterAll(() => {
  client?.close();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.executeMultiple(`
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

describe("check-artifact-gates", () => {
  it("throws when the sprint doesn't exist or isn't accessible", async () => {
    await expect(
      asUser(() =>
        checkArtifactGates.run({ sprintId: "nope", docKey: "sprint-doc" }),
      ),
    ).rejects.toThrow(/not found/i);
  });

  it("returns an empty, incomplete result with a note when no artifact exists yet for the docKey", async () => {
    const result = await asUser(() =>
      checkArtifactGates.run({ sprintId: "sprint-1", docKey: "sprint-doc" }),
    );
    expect(result.items).toEqual([]);
    expect(result.complete).toBe(false);
    expect(result.artifactId).toBeNull();
    expect(result.note).toMatch(/sprint-doc/);
  });

  it("gates sprint-doc deterministically and reports complete=true only when all machine items pass", async () => {
    const content = `## Success Metrics

- M1 | Leading | 指标 | 信号

## In-Scope

- O1: 范围内容

## Out-of-Scope

- 不在范围内
`;
    await asUser(() =>
      createSprintArtifact.run({
        sprintId: "sprint-1",
        docKey: "sprint-doc",
        kind: "文档",
        name: "Sprint Doc",
        content,
      }),
    );

    const result = await asUser(() =>
      checkArtifactGates.run({ sprintId: "sprint-1", docKey: "sprint-doc" }),
    );
    expect(result.version).toBe(1);
    expect(result.complete).toBe(true); // human item ignored for `complete`
    expect(result.items.some((i: any) => i.source === "human")).toBe(true);
  });

  it("ui-spec gating automatically reads the latest sprint-doc for outcome-mapping context", async () => {
    await asUser(() =>
      createSprintArtifact.run({
        sprintId: "sprint-1",
        docKey: "sprint-doc",
        kind: "文档",
        name: "Sprint Doc",
        content: "## In-Scope\n\n- O1: 范围内容\n",
      }),
    );
    await asUser(() =>
      createSprintArtifact.run({
        sprintId: "sprint-1",
        docKey: "ui-spec",
        kind: "设计",
        name: "UI Spec",
        content:
          "## 屏清单\n\n- S1 · 登录页\n\n## 逐屏规格\n\n### S1 · 登录页\n\n- **关联 Outcome**: O1\n",
      }),
    );

    const result = await asUser(() =>
      checkArtifactGates.run({ sprintId: "sprint-1", docKey: "ui-spec" }),
    );
    const mapped = result.items.find(
      (i: any) => i.key === "outcomes-mapped-to-screens",
    );
    expect(mapped.source).toBe("machine"); // resolved via the fetched sprint-doc, not needs-human
    expect(mapped.state).toBe("pass");
  });

  it("tech-design gating automatically reads the sprint's work-item count", async () => {
    await db.insert(trackerSchema.workItems).values({
      id: "wi-1",
      projectId: "proj-1",
      type: "task",
      title: "t",
      status: "open",
      priority: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ownerEmail: OWNER,
      orgId: ORG_ID,
      sprintId: "sprint-1",
      itemKey: "PRJ-001",
      currentStageName: "设计",
    });
    await asUser(() =>
      createSprintArtifact.run({
        sprintId: "sprint-1",
        docKey: "tech-design",
        kind: "设计",
        name: "技术设计",
        content:
          "## §4 工作项设计\n\n### §4.1 PRJ-001 · x\n\nbody\n\n## §7 文件变更矩阵\n\n| 文件路径 | 操作 | 所属工作项 | 说明 | 依赖文件 |\n| --- | --- | --- | --- | --- |\n| `a.ts` | CREATE | PRJ-001 | x | |\n",
      }),
    );

    const result = await asUser(() =>
      checkArtifactGates.run({ sprintId: "sprint-1", docKey: "tech-design" }),
    );
    const item = result.items.find(
      (i: any) => i.key === "section-count-matches-items",
    );
    expect(item.source).toBe("machine");
    expect(item.state).toBe("pass"); // §4 has 1 section, sprint has 1 work item
  });

  it("falls back to a placeholder non-empty check for a docKey with no §5.2 rule set", async () => {
    await asUser(() =>
      createSprintArtifact.run({
        sprintId: "sprint-1",
        docKey: "story",
        kind: "故事",
        name: "Story",
        content: "some narrative",
      }),
    );
    const result = await asUser(() =>
      checkArtifactGates.run({ sprintId: "sprint-1", docKey: "story" }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0].key).toBe("content-non-empty");
    expect(result.complete).toBe(true);
  });
});
