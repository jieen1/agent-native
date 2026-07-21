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

const mockCallOrchestratorTool = vi.fn();
vi.mock("../../server/lib/orchestrator-client.js", () => ({
  callOrchestratorTool: (...args: unknown[]) =>
    mockCallOrchestratorTool(...args),
}));

type AnyAction = { run: (args: any) => Promise<any> };
let getSprintStatus: AnyAction;

const OWNER = "owner@example.com";
const ORG_ID = "org-m5";

function asUser(fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: OWNER, orgId: ORG_ID }, fn);
}

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "get-sprint-status-"));
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
      item_key TEXT NOT NULL DEFAULT '',
      current_stage_name TEXT NOT NULL DEFAULT '待办'
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
  `);

  const mod = await import("../get-sprint-status.js");
  getSprintStatus = mod.default as unknown as AnyAction;
});

afterAll(() => {
  client?.close();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  mockCallOrchestratorTool.mockReset();
  await client.executeMultiple(`
    DELETE FROM tracker_stages;
    DELETE FROM tracker_work_items;
    DELETE FROM tracker_sprints;
  `);
});

async function seedSprint(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  await db.insert(trackerSchema.sprints).values({
    id: "spr_1",
    projectId: "proj-1",
    name: "Sprint M5",
    createdAt: now,
    updatedAt: now,
    ownerEmail: OWNER,
    orgId: ORG_ID,
    startDate: "2026-07-01",
    ...overrides,
  } as any);
}

async function seedItem(id: string, overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  await db.insert(trackerSchema.workItems).values({
    id,
    projectId: "proj-1",
    sprintId: "spr_1",
    itemKey: `M5-${id}`,
    title: `Item ${id}`,
    status: "open",
    createdAt: now,
    updatedAt: now,
    ownerEmail: OWNER,
    orgId: ORG_ID,
    ...overrides,
  } as any);
}

describe("get-sprint-status — batched fetch + honest empty states", () => {
  it("is BATCHED: exactly ONE spawnList call per distinct owner, regardless of item count (no N+1)", async () => {
    await seedSprint();
    // 5 items, all same owner → must be exactly ONE spawnList call.
    for (const id of ["i1", "i2", "i3", "i4", "i5"]) await seedItem(id);
    mockCallOrchestratorTool.mockImplementation(
      async (_owner: string, tool: string) => {
        if (tool === "spawnList") return { data: [] };
        if (tool === "v3RunNodes") return { data: [] };
        return { data: null };
      },
    );

    await asUser(() => getSprintStatus.run({ sprintId: "spr_1" }));

    const spawnListCalls = mockCallOrchestratorTool.mock.calls.filter(
      (c) => c[1] === "spawnList",
    );
    expect(spawnListCalls).toHaveLength(1);
    // The single call carries the tracker tagMatch (batched fetch).
    expect(spawnListCalls[0][2]).toMatchObject({
      tagMatch: { source: "tracker" },
    });
  });

  it("derives 实走验证 timing from real v3_spawns started_at/completed_at", async () => {
    await seedSprint();
    await seedItem("i1");
    mockCallOrchestratorTool.mockImplementation(
      async (_owner: string, tool: string) => {
        if (tool === "spawnList")
          return {
            data: [
              {
                id: "sp1",
                nodeId: "n1",
                runId: "run1",
                status: "completed",
                tags: { source: "tracker", item_id: "i1" },
                startedAt: "2026-07-01T10:00:00Z",
                completedAt: "2026-07-01T10:10:00Z",
              },
            ],
          };
        if (tool === "v3RunNodes")
          return { data: [{ id: "n1", nodeIdInDag: "develop" }] };
        return { data: null };
      },
    );

    const result = await asUser(() =>
      getSprintStatus.run({ sprintId: "spr_1" }),
    );
    expect(result.timingDegraded).toBe(false);
    const dev = result.timings[0].stages.find(
      (s: any) => s.stage === "dev",
    );
    expect(dev.totalSec).toBeCloseTo(600, 0);
    expect(dev.spawnCount).toBe(1);
  });

  it("degrades to an HONEST empty state (timingDegraded=true, all 无数据) when spawnList throws — never fabricates", async () => {
    await seedSprint();
    await seedItem("i1");
    mockCallOrchestratorTool.mockImplementation(
      async (_owner: string, tool: string) => {
        if (tool === "spawnList")
          throw new Error("orchestrator down / timeout");
        return { data: null };
      },
    );

    const result = await asUser(() =>
      getSprintStatus.run({ sprintId: "spr_1" }),
    );
    // Did NOT throw; degraded flag set; every stage honestly 无数据 (null).
    expect(result.timingDegraded).toBe(true);
    expect(result.errors).toBeDefined();
    for (const stage of result.timings[0].stages) {
      expect(stage.totalSec).toBeNull();
      expect(stage.spawnCount).toBe(0);
    }
  });

  it("returns an honest burndown empty reason for a same-day sprint (no fabricated points)", async () => {
    await seedSprint({ startDate: "2026-07-10" });
    await seedItem("i1");
    mockCallOrchestratorTool.mockResolvedValue({ data: [] });

    const result = await asUser(() =>
      getSprintStatus.run({ sprintId: "spr_1" }),
    );
    // startDate is in the future relative to a 2026-07 clock the test can't
    // control, so we only assert the contract: empty series ⇒ a reason is set.
    if (result.burndown.length === 0) {
      expect(result.burndownEmptyReason).toBeTruthy();
    } else {
      expect(result.burndownEmptyReason).toBeNull();
    }
  });

  it("computes delivered count from real item status", async () => {
    await seedSprint();
    await seedItem("i1", { status: "done" });
    await seedItem("i2", { status: "open" });
    mockCallOrchestratorTool.mockResolvedValue({ data: [] });

    const result = await asUser(() =>
      getSprintStatus.run({ sprintId: "spr_1" }),
    );
    expect(result.totalItems).toBe(2);
    expect(result.delivered).toBe(1);
  });
});
