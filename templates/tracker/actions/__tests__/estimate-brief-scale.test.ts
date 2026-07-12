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

type AnyAction = { run: (args: any) => Promise<any> };
let estimateBriefScale: AnyAction;

const OWNER = "owner@example.com";
const ORG_ID = "org-f5";

function asUser(fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: OWNER, orgId: ORG_ID }, fn);
}

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "estimate-brief-scale-"));
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

  const mod = await import("../estimate-brief-scale.js");
  estimateBriefScale = mod.default as unknown as AnyAction;
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
  const id =
    (overrides.id as string) ?? `wi_${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(trackerSchema.workItems).values({
    id,
    projectId: "proj-1",
    type: "task",
    title: "Test item",
    description:
      "12 文件级改动:`a/1.ts` `a/2.ts` `a/3.ts` `a/4.ts` `a/5.ts` `a/6.ts` `a/7.ts`",
    status: "open",
    priority: 1,
    createdAt: now,
    updatedAt: now,
    ownerEmail: OWNER,
    orgId: ORG_ID,
    itemKey: "F5-1",
    currentStageName: "待办",
    ...overrides,
  });
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

// ============================================================================
// T-F5-02: estimate-brief-scale 幂等
// ============================================================================

describe("T-F5-02: estimate-brief-scale 幂等", () => {
  it("同一工作项连调两次 — 两次返回的估算字段深相等,列只有一份 JSON", async () => {
    const id = await insertItem();

    const first = await asUser(() =>
      estimateBriefScale.run({ workItemId: id }),
    );
    const second = await asUser(() =>
      estimateBriefScale.run({ workItemId: id }),
    );

    // Compare the substantive estimate (not `at`, which legitimately advances
    // between calls — see estimate-brief-scale.ts's docblock).
    expect(second.files).toEqual(first.files);
    expect(second.crossLifecycle).toEqual(first.crossLifecycle);
    expect(second.verdict).toEqual(first.verdict);
    expect(second.signals).toEqual(first.signals);
    expect(first.verdict).toBe("split-required"); // 7 文件 > 6

    const row = await fetchItem(id);
    // The column holds exactly one JSON object, not an array / duplicated blob.
    const parsed = JSON.parse((row as any).scaleEstimate);
    expect(Array.isArray(parsed)).toBe(false);
    expect(parsed.files).toBe(first.files);
    expect(parsed.verdict).toBe(first.verdict);
  });

  it("does not touch updatedAt (derived/cache field, not a user edit)", async () => {
    const id = await insertItem();
    const before = await fetchItem(id);
    await asUser(() => estimateBriefScale.run({ workItemId: id }));
    const after = await fetchItem(id);
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it("estimates from the persisted description text (ok verdict for a small brief)", async () => {
    const id = await insertItem({ description: "Just tweak the label copy." });
    const result = await asUser(() =>
      estimateBriefScale.run({ workItemId: id }),
    );
    expect(result.verdict).toBe("ok");
    expect(result.files).toBe(0);
  });
});
