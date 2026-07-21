import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { createClient, type Client } from "@libsql/client";
import { and, eq } from "drizzle-orm";
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
let generateRecap: AnyAction;

const OWNER = "owner@example.com";
const ORG_ID = "org-m5-recap";

function asUser(fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: OWNER, orgId: ORG_ID }, fn);
}

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "generate-sprint-recap-"));
  client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
  db = drizzle(client, { schema: trackerSchema });

  await client.executeMultiple(`
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
    CREATE TABLE tracker_work_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'requirement',
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      owner_email TEXT NOT NULL,
      org_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private',
      sprint_id TEXT,
      item_key TEXT NOT NULL DEFAULT ''
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
      created_at TEXT NOT NULL,
      anchor_artifact_id TEXT,
      anchor_version INTEGER,
      stale_at TEXT,
      owner_email TEXT NOT NULL,
      org_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
    );
    CREATE TABLE tracker_comments (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      author_kind TEXT DEFAULT 'human',
      author_name TEXT DEFAULT '',
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
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

  const mod = await import("../generate-sprint-recap.js");
  generateRecap = mod.default as unknown as AnyAction;
});

afterAll(() => {
  client?.close();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.executeMultiple(`
    DELETE FROM tracker_sprint_artifacts;
    DELETE FROM tracker_work_item_runs;
    DELETE FROM tracker_stages;
    DELETE FROM tracker_comments;
    DELETE FROM tracker_approvals;
    DELETE FROM tracker_work_items;
    DELETE FROM tracker_sprints;
  `);
  const now = new Date().toISOString();
  await db.insert(trackerSchema.sprints).values({
    id: "spr_1",
    projectId: "proj-1",
    name: "Sprint M5",
    phase: "verifying",
    createdAt: now,
    updatedAt: now,
    ownerEmail: OWNER,
    orgId: ORG_ID,
  } as any);
  await db.insert(trackerSchema.workItems).values({
    id: "i1",
    projectId: "proj-1",
    sprintId: "spr_1",
    itemKey: "M5-1",
    title: "Item 1",
    createdAt: now,
    updatedAt: now,
    ownerEmail: OWNER,
    orgId: ORG_ID,
  } as any);
});

describe("generate-sprint-recap — transactional write + honest no-intervention", () => {
  it("writes a versioned sprint-recap artifact and advances phase in ONE transaction", async () => {
    const result = await asUser(() =>
      generateRecap.run({ sprintId: "spr_1" }),
    );
    expect(result.docKey).toBe("sprint-recap");
    expect(result.version).toBe(1);
    expect(result.phase).toBe("done");

    const artifacts = await db
      .select()
      .from(trackerSchema.sprintArtifacts)
      .where(
        and(
          eq(trackerSchema.sprintArtifacts.sprintId, "spr_1"),
          eq(trackerSchema.sprintArtifacts.docKey, "sprint-recap"),
        ),
      );
    expect(artifacts).toHaveLength(1);

    const sprint = (
      await db
        .select()
        .from(trackerSchema.sprints)
        .where(eq(trackerSchema.sprints.id, "spr_1"))
    )[0];
    expect(sprint.phase).toBe("done");
  });

  it("reports noInterventions honestly when there are no records", async () => {
    const result = await asUser(() =>
      generateRecap.run({ sprintId: "spr_1" }),
    );
    expect(result.noInterventions).toBe(true);
    expect(result.entryCount).toBe(0);
    const artifact = (
      await db
        .select()
        .from(trackerSchema.sprintArtifacts)
        .where(eq(trackerSchema.sprintArtifacts.sprintId, "spr_1"))
    )[0];
    expect(artifact.content).toContain("无人工干预记录");
  });

  it("counts real interventions from approvals/comments/stages/runs", async () => {
    const now = new Date().toISOString();
    await db.insert(trackerSchema.approvals).values({
      id: "apr_1",
      sprintId: "spr_1",
      workItemId: "i1",
      gateKey: "plan-signoff",
      status: "approved",
      requestedBy: OWNER,
      decidedBy: OWNER,
      createdAt: now,
      decidedAt: now,
      ownerEmail: OWNER,
      orgId: ORG_ID,
    } as any);
    await db.insert(trackerSchema.comments).values({
      id: "cmt_1",
      workItemId: "i1",
      authorKind: "human",
      authorName: "Human",
      body: "change direction",
      createdAt: now,
      ownerEmail: OWNER,
      orgId: ORG_ID,
    } as any);
    await db.insert(trackerSchema.stages).values({
      id: "stg_1",
      workItemId: "i1",
      stageName: "验收",
      stageStatus: "已驳回",
      verdict: JSON.stringify({ reason: "failed" }),
      createdAt: now,
      updatedAt: now,
      ownerEmail: OWNER,
      orgId: ORG_ID,
    } as any);
    await db.insert(trackerSchema.workItemRuns).values({
      id: "run_1",
      workItemId: "i1",
      dispatchedAt: now,
      superseded: 1,
      createdAt: now,
      ownerEmail: OWNER,
      orgId: ORG_ID,
    } as any);

    const result = await asUser(() =>
      generateRecap.run({ sprintId: "spr_1" }),
    );
    expect(result.noInterventions).toBe(false);
    expect(result.entryCount).toBe(4);
    expect(result.counts).toEqual({
      approval: 1,
      correction: 2,
      escalation: 1,
    });
  });

  it("auto-increments version on a second generation (supersedes chain)", async () => {
    const r1 = await asUser(() => generateRecap.run({ sprintId: "spr_1" }));
    const r2 = await asUser(() => generateRecap.run({ sprintId: "spr_1" }));
    expect(r1.version).toBe(1);
    expect(r2.version).toBe(2);
    expect(r2.supersedes).toBe(r1.id);
  });
});
