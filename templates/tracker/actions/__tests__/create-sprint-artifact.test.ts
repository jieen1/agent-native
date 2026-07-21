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
let createSprintArtifact: AnyAction;

const OWNER = "owner@example.com";
const ORG_ID = "org-atomicity";

function asUser(fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: OWNER, orgId: ORG_ID }, fn);
}

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "create-sprint-artifact-"));
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
      owner_email TEXT,
      org_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
    );
  `);

  const mod = await import("../create-sprint-artifact.js");
  createSprintArtifact = mod.default as unknown as AnyAction;
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
    name: "Test Project",
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
  await db.insert(trackerSchema.workItems).values({
    id: "wi-1",
    projectId: "proj-1",
    type: "task",
    title: "Test work item",
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
});

// ── Helper: seed a v1 artifact + an approved approval anchored to it ─────────

async function seedV1WithAnchoredApproval() {
  // Create v1 artifact
  const v1 = await asUser(() =>
    createSprintArtifact.run({
      sprintId: "sprint-1",
      docKey: "tech-design",
      kind: "设计",
      name: "Tech Design v1",
      content: "## §1 Overview\n\nInitial design.",
    }),
  );

  // Insert an approved approval anchored to v1
  await db.insert(trackerSchema.approvals).values({
    id: "approval-anchored-v1",
    sprintId: "sprint-1",
    workItemId: "wi-1",
    gateKey: "design-review",
    status: "approved",
    requestedBy: OWNER,
    reason: "Initial approval",
    createdAt: new Date().toISOString(),
    anchorArtifactId: v1.id,
    anchorVersion: 1,
    ownerEmail: OWNER,
    orgId: ORG_ID,
  });

  return v1;
}

// ============================================================================

describe("create-sprint-artifact B2 stale logic", () => {
  it("happy path: creating v2 stales the anchored approval, creates reconfirmation, and writes activity log", async () => {
    await seedV1WithAnchoredApproval();

    // Create v2 — triggers B2 stale logic
    const v2 = await asUser(() =>
      createSprintArtifact.run({
        sprintId: "sprint-1",
        docKey: "tech-design",
        kind: "设计",
        name: "Tech Design v2",
        content: "## §1 Overview\n\nRevised design.",
      }),
    );

    expect(v2.version).toBe(2);
    expect(v2.staleApprovals).toHaveLength(1);
    expect(v2.staleApprovals[0].id).toBe("approval-anchored-v1");
    expect(v2.reconfirmationApprovals).toHaveLength(1);
    expect(v2.reconfirmationApprovals[0].status).toBe("pending");

    // Verify DB state: original approval is now stale
    const [staleApproval] = await db
      .select()
      .from(trackerSchema.approvals)
      .where(eq(trackerSchema.approvals.id, "approval-anchored-v1"));
    expect(staleApproval.staleAt).not.toBeNull();

    // Verify: reconfirmation approval exists
    const reconfirms = await db
      .select()
      .from(trackerSchema.approvals)
      .where(
        and(
          eq(trackerSchema.approvals.sprintId, "sprint-1"),
          eq(trackerSchema.approvals.status, "pending"),
          eq(trackerSchema.approvals.anchorVersion, 2),
        ),
      );
    expect(reconfirms).toHaveLength(1);
    expect(reconfirms[0].anchorArtifactId).toBe(v2.id);

    // Verify: activity log entries exist (approval.stale + approval.reconfirm_requested)
    const activities = await db
      .select()
      .from(trackerSchema.activities)
      .where(eq(trackerSchema.activities.workItemId, "wi-1"));
    const eventTypes = activities.map((a) => a.eventType).sort();
    expect(eventTypes).toEqual([
      "approval.reconfirm_requested",
      "approval.stale",
    ]);
  });

  it("atomicity: if the activity-log write fails, the stale update and reconfirmation insert are rolled back", async () => {
    await seedV1WithAnchoredApproval();

    // Inject a failure: a trigger that aborts any activity insert with
    // event_type = 'approval.reconfirm_requested' (the 3rd write kind).
    await client.execute(`
      CREATE TRIGGER fail_reconfirm_activity
      BEFORE INSERT ON tracker_activities
      WHEN NEW.event_type = 'approval.reconfirm_requested'
      BEGIN
        SELECT RAISE(ABORT, 'injected failure: activity write');
      END;
    `);

    // The action should throw on the activity-log insert (the 3rd write kind).
    // The drizzle/libsql layer wraps the underlying SQLite trigger error into a
    // "Failed query: insert into tracker_activities ..." message, so assert on
    // the failing statement rather than the raw RAISE() text.
    await expect(
      asUser(() =>
        createSprintArtifact.run({
          sprintId: "sprint-1",
          docKey: "tech-design",
          kind: "设计",
          name: "Tech Design v2",
          content: "## §1 Overview\n\nRevised design.",
        }),
      ),
    ).rejects.toThrow(/tracker_activities/);

    // Drop the trigger so subsequent queries work normally
    await client.execute("DROP TRIGGER IF EXISTS fail_reconfirm_activity;");

    // Assert: the stale flag was NOT persisted (rolled back)
    const [approval] = await db
      .select()
      .from(trackerSchema.approvals)
      .where(eq(trackerSchema.approvals.id, "approval-anchored-v1"));
    expect(approval.staleAt).toBeNull();

    // Assert: no reconfirmation approval was created (rolled back)
    const reconfirms = await db
      .select()
      .from(trackerSchema.approvals)
      .where(
        and(
          eq(trackerSchema.approvals.sprintId, "sprint-1"),
          eq(trackerSchema.approvals.status, "pending"),
        ),
      );
    expect(reconfirms).toHaveLength(0);

    // Assert: no activity rows were written (rolled back)
    const activities = await db
      .select()
      .from(trackerSchema.activities)
      .where(eq(trackerSchema.activities.workItemId, "wi-1"));
    expect(activities).toHaveLength(0);
  });
});
