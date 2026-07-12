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
let updateWorkItem: AnyAction;

const OWNER = "owner@example.com";
const ORG_ID = "org-f3";

function asUser(fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: OWNER, orgId: ORG_ID }, fn);
}

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "update-work-item-"));
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
  `);

  const mod = await import("../update-work-item.js");
  updateWorkItem = mod.default as unknown as AnyAction;
}, 30_000);

afterAll(() => {
  client?.close();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.executeMultiple(`DELETE FROM tracker_work_items;`);
});

async function insertItem(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  const id = "wi-1";
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
    currentStageName: "待办",
    ...overrides,
  });
  return id;
}

async function fetchItem(id: string) {
  return (
    await db.select().from(trackerSchema.workItems).where(eq(trackerSchema.workItems.id, id))
  )[0];
}

// ============================================================================
// T-F3-07: update-work-item 拒 currentStageName (real action, not just the
// schemas.test.ts mirror — this exercises the ACTUAL defineAction().schema).
// ============================================================================

describe("T-F3-07: update-work-item 拒绝 currentStageName (real action schema)", () => {
  it("a call carrying currentStageName is rejected by schema validation before touching the DB", async () => {
    const id = await insertItem({ currentStageName: "待办" });

    await expect(
      asUser(() =>
        updateWorkItem.run({ id, currentStageName: "实施" } as any),
      ),
    ).rejects.toThrow();

    const row = await fetchItem(id);
    expect(row.currentStageName).toBe("待办"); // untouched — bypass fully blocked
  });

  it("ordinary metadata fields (priority, risk, tags, owner, nature) still work", async () => {
    const id = await insertItem();
    const updated = await asUser(() =>
      updateWorkItem.run({
        id,
        priority: 3,
        risk: "high",
        tags: ["urgent"],
        owner: "alice@example.com",
        nature: ["后端"],
      }),
    );
    expect(updated.priority).toBe(3);
    expect(updated.risk).toBe("high");
    expect(updated.owner).toBe("alice@example.com");
  });
});
