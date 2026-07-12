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
let listWorkItems: AnyAction;

const OWNER = "owner@example.com";
const ORG_ID = "org-f8";

function asUser(fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: OWNER, orgId: ORG_ID }, fn);
}

beforeEach(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "list-work-items-"));
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
  `);
  const mod = await import("../list-work-items.js");
  listWorkItems = mod.default as unknown as AnyAction;
});

afterAll(() => {
  client?.close();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

async function insertItem(
  id: string,
  projectId: string,
  itemKey: string,
  overrides: Record<string, unknown> = {},
) {
  const now = new Date().toISOString();
  await db.insert(trackerSchema.workItems).values({
    id,
    projectId,
    itemKey,
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

// ============================================================================
// T-F8-05: itemKey 消歧(读路径) — list-work-items is one of the two actions
// the F8 spec names explicitly (alongside get-work-item).
// ============================================================================
describe("T-F8-05: list-work-items itemKey 消歧", () => {
  it("a real duplicate pair (two items, same project, same itemKey) gets distinct itemKeyDisplay values", async () => {
    await insertItem("wi-a", "proj-1", "SDLC-033");
    await insertItem("wi-b", "proj-1", "SDLC-033");

    const rows = await asUser(() => listWorkItems.run({ projectId: "proj-1" }));
    const a = rows.find((r: any) => r.id === "wi-a");
    const b = rows.find((r: any) => r.id === "wi-b");

    expect(a.itemKeyDisplay).not.toBe(b.itemKeyDisplay);
    expect(a.itemKeyDisplay).toMatch(/^SDLC-033·/);
    expect(b.itemKeyDisplay).toMatch(/^SDLC-033·/);
    // Raw itemKey is untouched.
    expect(a.itemKey).toBe("SDLC-033");
    expect(b.itemKey).toBe("SDLC-033");
  });

  it("a unique itemKey is returned WITHOUT a suffix", async () => {
    await insertItem("wi-c", "proj-1", "SDLC-040");
    const rows = await asUser(() => listWorkItems.run({ projectId: "proj-1" }));
    const c = rows.find((r: any) => r.id === "wi-c");
    expect(c.itemKeyDisplay).toBe("SDLC-040");
  });

  it("status-filtered list still flags a duplicate whose sibling was filtered out", async () => {
    await insertItem("wi-a", "proj-1", "SDLC-033", { status: "open" });
    await insertItem("wi-b", "proj-1", "SDLC-033", { status: "closed" });

    const rows = await asUser(() =>
      listWorkItems.run({ projectId: "proj-1", status: "open" }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("wi-a");
    expect(rows[0].itemKeyDisplay).toMatch(/^SDLC-033·/);
  });
});
