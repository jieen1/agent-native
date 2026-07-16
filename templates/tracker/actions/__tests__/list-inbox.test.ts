import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as trackerSchema from "../../server/db/schema.js";

let client: Client;
let db: LibSQLDatabase<typeof trackerSchema>;
let dbDir: string;

vi.mock("../../server/db/index.js", () => ({
  getDb: () => db,
  schema: trackerSchema,
}));

type AnyAction = { run: (args: any) => Promise<any> };
let listInbox: AnyAction;

const OWNER = "owner@example.com";
const ORG_ID = "org-r3";
const OTHER_OWNER = "someone-else@example.com";

function asUser(fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: OWNER, orgId: ORG_ID }, fn);
}

function asOtherUser(fn: () => Promise<any> | any) {
  return runWithRequestContext(
    { userEmail: OTHER_OWNER, orgId: "org-other" },
    fn,
  );
}

beforeEach(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "list-inbox-"));
  client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
  db = drizzle(client, { schema: trackerSchema });
  await client.executeMultiple(`
    CREATE TABLE tracker_work_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      sprint_id TEXT,
      item_key TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'requirement',
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      priority INTEGER NOT NULL DEFAULT 0,
      risk TEXT NOT NULL DEFAULT 'medium',
      tags TEXT NOT NULL DEFAULT '[]',
      nature TEXT NOT NULL DEFAULT '[]',
      owner TEXT,
      execution_mode TEXT NOT NULL DEFAULT 'manual',
      planned_stages TEXT NOT NULL DEFAULT '[]',
      current_stage_name TEXT NOT NULL DEFAULT '待办',
      branch TEXT,
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
      exec_state TEXT,
      closed_reason TEXT,
      closed_at TEXT,
      scale_estimate TEXT,
      split_parent_id TEXT
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
  const mod = await import("../list-inbox.js");
  listInbox = mod.default as unknown as AnyAction;
});

afterAll(() => {
  client?.close();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

async function insertItem(id: string, overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  await db.insert(trackerSchema.workItems).values({
    id,
    projectId: "proj-1",
    itemKey: `TRK-${id}`,
    title: `Item ${id}`,
    description: "",
    status: "open",
    createdAt: now,
    updatedAt: now,
    ownerEmail: OWNER,
    orgId: ORG_ID,
    ...overrides,
  } as any);
}

async function insertApproval(
  id: string,
  overrides: Record<string, unknown> = {},
) {
  const now = new Date().toISOString();
  await db.insert(trackerSchema.approvals).values({
    id,
    sprintId: "sprint-1",
    gateKey: "plan-signoff",
    status: "pending",
    requestedBy: OWNER,
    createdAt: now,
    ownerEmail: OWNER,
    orgId: ORG_ID,
    ...overrides,
  } as any);
}

describe("list-inbox — empty state", () => {
  it("returns all-empty groups and zero counts with no data", async () => {
    const result = await asUser(() => listInbox.run({}));
    expect(result.groups).toEqual({
      signoff: [],
      escalation: [],
      reviewRequest: [],
      failedRouting: [],
      notifications: [],
    });
    expect(result.counts).toEqual({
      signoff: 0,
      escalation: 0,
      reviewRequest: 0,
      failedRouting: 0,
      notifications: 0,
      total: 0,
    });
  });

  it("notifications is always empty — no cross-item event feed data source exists", async () => {
    await insertApproval("a1");
    await insertItem("w1", { status: "failed" });
    const result = await asUser(() => listInbox.run({}));
    expect(result.groups.notifications).toEqual([]);
    expect(result.counts.notifications).toBe(0);
  });
});

describe("list-inbox — signoff group (real GateKey values only)", () => {
  it("classifies plan-signoff and design-signoff approvals as signoff", async () => {
    await insertApproval("a1", { gateKey: "plan-signoff" });
    await insertApproval("a2", { gateKey: "design-signoff" });
    const result = await asUser(() => listInbox.run({}));
    expect(result.groups.signoff).toHaveLength(2);
    expect(result.groups.signoff.map((r: any) => r.gateKey).sort()).toEqual([
      "design-signoff",
      "plan-signoff",
    ]);
    expect(result.groups.signoff.every((r: any) => r.group === "signoff")).toBe(
      true,
    );
  });

  it("excludes approved/rejected approvals", async () => {
    await insertApproval("a1", { gateKey: "plan-signoff", status: "approved" });
    await insertApproval("a2", { gateKey: "plan-signoff", status: "rejected" });
    await insertApproval("a3", { gateKey: "plan-signoff", status: "pending" });
    const result = await asUser(() => listInbox.run({}));
    expect(result.groups.signoff).toHaveLength(1);
    expect(result.groups.signoff[0].approvalId).toBe("a3");
  });

  it("carries routing fields (sprintId, workItemId, requestedBy)", async () => {
    await insertApproval("a1", {
      gateKey: "plan-signoff",
      sprintId: "sprint-42",
      workItemId: "wi-9",
      requestedBy: "alice@example.com",
    });
    const result = await asUser(() => listInbox.run({}));
    const row = result.groups.signoff[0];
    expect(row.sprintId).toBe("sprint-42");
    expect(row.workItemId).toBe("wi-9");
    expect(row.requestedBy).toBe("alice@example.com");
    expect(row.status).toBe("pending");
  });
});

describe("list-inbox — escalation group (escalation/audit-deferral share the approvals table)", () => {
  it("classifies escalation and audit-deferral approvals as escalation, not signoff", async () => {
    await insertApproval("a1", { gateKey: "escalation" });
    await insertApproval("a2", { gateKey: "audit-deferral" });
    await insertApproval("a3", { gateKey: "plan-signoff" });
    const result = await asUser(() => listInbox.run({}));
    expect(result.groups.escalation).toHaveLength(2);
    expect(result.groups.escalation.map((r: any) => r.gateKey).sort()).toEqual([
      "audit-deferral",
      "escalation",
    ]);
    expect(result.groups.signoff).toHaveLength(1);
  });
});

describe("list-inbox — reviewRequest group (real DB value is 验收, not 待人工评审)", () => {
  it("includes work items whose currentStageName is 验收", async () => {
    await insertItem("w1", { currentStageName: "验收", status: "returned" });
    const result = await asUser(() => listInbox.run({}));
    expect(result.groups.reviewRequest).toHaveLength(1);
    expect(result.groups.reviewRequest[0].workItemId).toBe("w1");
    expect(result.groups.reviewRequest[0].currentStageName).toBe("验收");
  });

  it("excludes items at other stages, including the literal string 待人工评审", async () => {
    await insertItem("w1", { currentStageName: "实施" });
    await insertItem("w2", { currentStageName: "待人工评审" });
    await insertItem("w3", { currentStageName: "交付" });
    const result = await asUser(() => listInbox.run({}));
    expect(result.groups.reviewRequest).toEqual([]);
  });

  it("resolves itemKeyDisplay for duplicate itemKeys via computeItemKeyDisplays", async () => {
    await insertItem("w1", { itemKey: "DUP-1", currentStageName: "验收" });
    await insertItem("w2", { itemKey: "DUP-1", currentStageName: "验收" });
    const result = await asUser(() => listInbox.run({}));
    const rows = result.groups.reviewRequest;
    expect(rows).toHaveLength(2);
    expect(rows[0].itemKeyDisplay).toMatch(/^DUP-1·/);
    expect(rows[1].itemKeyDisplay).toMatch(/^DUP-1·/);
  });
});

describe("list-inbox — failedRouting group", () => {
  it("includes work items with status=failed", async () => {
    await insertItem("w1", { status: "failed", currentStageName: "实施" });
    const result = await asUser(() => listInbox.run({}));
    expect(result.groups.failedRouting).toHaveLength(1);
    expect(result.groups.failedRouting[0].workItemId).toBe("w1");
    expect(result.groups.failedRouting[0].status).toBe("failed");
  });

  it("excludes non-failed statuses", async () => {
    await insertItem("w1", { status: "open" });
    await insertItem("w2", { status: "done" });
    await insertItem("w3", { status: "dispatched" });
    const result = await asUser(() => listInbox.run({}));
    expect(result.groups.failedRouting).toEqual([]);
  });

  it("a work item can appear in reviewRequest and failedRouting is mutually exclusive by construction", async () => {
    // 验收 + failed simultaneously would be unusual but the two filters are
    // independent (currentStageName vs status) — confirm both fire when both
    // conditions are true, matching real free-text status semantics.
    await insertItem("w1", { currentStageName: "验收", status: "failed" });
    const result = await asUser(() => listInbox.run({}));
    expect(result.groups.reviewRequest).toHaveLength(1);
    expect(result.groups.failedRouting).toHaveLength(1);
    expect(result.groups.reviewRequest[0].workItemId).toBe("w1");
    expect(result.groups.failedRouting[0].workItemId).toBe("w1");
  });
});

describe("list-inbox — counts", () => {
  it("total sums every non-notification group", async () => {
    await insertApproval("a1", { gateKey: "plan-signoff" });
    await insertApproval("a2", { gateKey: "escalation" });
    await insertItem("w1", { currentStageName: "验收" });
    await insertItem("w2", { status: "failed" });
    await insertItem("w3", { status: "failed" });
    const result = await asUser(() => listInbox.run({}));
    expect(result.counts).toEqual({
      signoff: 1,
      escalation: 1,
      reviewRequest: 1,
      failedRouting: 2,
      notifications: 0,
      total: 5,
    });
  });
});

describe("list-inbox — owner scoping", () => {
  it("never returns another owner's approvals or work items", async () => {
    await insertApproval("a1", { gateKey: "plan-signoff" });
    await insertItem("w1", { status: "failed" });
    await insertItem("w2", { currentStageName: "验收" });

    const mine = await asUser(() => listInbox.run({}));
    expect(mine.counts.total).toBe(3);

    const theirs = await asOtherUser(() => listInbox.run({}));
    expect(theirs.counts.total).toBe(0);
    expect(theirs.groups).toEqual({
      signoff: [],
      escalation: [],
      reviewRequest: [],
      failedRouting: [],
      notifications: [],
    });
  });
});
