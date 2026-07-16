import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { createClient, type Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import {
  afterAll,
  afterEach,
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
let reorderQueue: AnyAction;

const OWNER = "owner@example.com";
const ORG_ID = "org-reorder";

function asUser(fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: OWNER, orgId: ORG_ID }, fn);
}

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "reorder-queue-"));
  client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
  db = drizzle(client, { schema: trackerSchema });

  await client.executeMultiple(`
    CREATE TABLE tracker_exec_queue (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL UNIQUE,
      priority INTEGER DEFAULT 0,
      status TEXT DEFAULT 'queued',
      current_stage TEXT DEFAULT '',
      enqueued_at TEXT NOT NULL,
      started_at TEXT,
      blocked_by TEXT DEFAULT '[]',
      position INTEGER,
      waiting_on TEXT DEFAULT '{}',
      health_check_log TEXT,
      owner_email TEXT NOT NULL,
      org_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
    );
  `);

  const mod = await import("../reorder-queue.js");
  reorderQueue = mod.default as unknown as AnyAction;
}, 30_000);

afterAll(() => {
  client?.close();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.executeMultiple(`DELETE FROM tracker_exec_queue;`);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function insertQueueRow(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  const workItemId =
    (overrides.workItemId as string) ??
    `wi_${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(trackerSchema.execQueue).values({
    id: `q_${workItemId}`,
    workItemId,
    priority: 0,
    status: "queued",
    currentStage: "待办",
    enqueuedAt: now,
    startedAt: null,
    blockedBy: "[]",
    position: null,
    waitingOn: "{}",
    healthCheckLog: null,
    ownerEmail: OWNER,
    orgId: ORG_ID,
    ...overrides,
  });
  return workItemId;
}

describe("reorder-queue", () => {
  it("assigns sequential 1-based positions in the given order (0 stays reserved as the unordered sentinel)", async () => {
    const a = await insertQueueRow();
    const b = await insertQueueRow();
    const c = await insertQueueRow();

    const result = await asUser(() =>
      reorderQueue.run({ workItemIds: [c, a, b] }),
    );
    expect(result.count).toBe(3);

    const rows = await db.select().from(trackerSchema.execQueue);
    const byWorkItem = new Map(rows.map((r) => [r.workItemId, r.position]));
    expect(byWorkItem.get(c)).toBe(1);
    expect(byWorkItem.get(a)).toBe(2);
    expect(byWorkItem.get(b)).toBe(3);
  });

  it("skips ids that are not this caller's queued rows rather than throwing", async () => {
    const a = await insertQueueRow();
    const blocked = await insertQueueRow({ status: "blocked" });
    const otherOwner = await insertQueueRow({
      ownerEmail: "someone-else@example.com",
      orgId: null,
    });

    const result = await asUser(() =>
      reorderQueue.run({ workItemIds: [a, blocked, otherOwner, "unknown-id"] }),
    );
    expect(result.updated).toEqual([a]);
    expect(result.count).toBe(1);

    const row = (
      await db
        .select()
        .from(trackerSchema.execQueue)
        .where(eq(trackerSchema.execQueue.workItemId, a))
    )[0]!;
    expect(row.position).toBe(1);
  });

  it("a second reorder call overwrites the previous positions", async () => {
    const a = await insertQueueRow();
    const b = await insertQueueRow();
    await asUser(() => reorderQueue.run({ workItemIds: [a, b] }));
    await asUser(() => reorderQueue.run({ workItemIds: [b, a] }));

    const rows = await db.select().from(trackerSchema.execQueue);
    const byWorkItem = new Map(rows.map((r) => [r.workItemId, r.position]));
    expect(byWorkItem.get(b)).toBe(1);
    expect(byWorkItem.get(a)).toBe(2);
  });

  it("throws when unauthenticated", async () => {
    await expect(reorderQueue.run({ workItemIds: ["x"] })).rejects.toThrow(
      /Not authenticated/,
    );
  });
});
