import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { createClient, type Client } from "@libsql/client";
import { desc, eq } from "drizzle-orm";
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
import { recordDispatchRun } from "../../server/lib/work-item-runs.js";
import { writebackActorEmail } from "../../server/lib/writeback-actor.js";

let client: Client;
let db: LibSQLDatabase<typeof trackerSchema>;
let dbDir: string;

vi.mock("../../server/db/index.js", () => ({
  getDb: () => db,
  schema: trackerSchema,
}));

type AnyAction = { run: (args: any, ctx?: any) => Promise<any> };
let writebackRunMeta: AnyAction;

const OWNER = "owner@example.com";
const ORG_ID = "org-f9";
const WRITEBACK_EMAIL = writebackActorEmail();

function asUser(fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: OWNER, orgId: ORG_ID }, fn);
}
function asWriteback(fn: () => Promise<any> | any) {
  return runWithRequestContext(
    { userEmail: WRITEBACK_EMAIL, orgId: ORG_ID },
    fn,
  );
}
function mcpCtx() {
  return { caller: "mcp" as const };
}

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "writeback-run-meta-"));
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

  const mod = await import("../writeback-run-meta.js");
  writebackRunMeta = mod.default as unknown as AnyAction;
});

afterAll(() => {
  client?.close();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.executeMultiple(`
    DELETE FROM tracker_activities;
    DELETE FROM tracker_work_item_runs;
    DELETE FROM tracker_work_items;
  `);
  await db.insert(trackerSchema.workItems).values({
    id: "wi-1",
    projectId: "proj-1",
    title: "t",
    description: "",
    status: "dispatched",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ownerEmail: OWNER,
    orgId: ORG_ID,
    itemKey: "F9-001",
    execState: "dispatched",
  } as any);
});

async function fetchRuns(workItemId: string) {
  return db
    .select()
    .from(trackerSchema.workItemRuns)
    .where(eq(trackerSchema.workItemRuns.workItemId, workItemId))
    .orderBy(desc(trackerSchema.workItemRuns.dispatchedAt));
}

async function fetchActivities(id: string) {
  return db
    .select()
    .from(trackerSchema.activities)
    .where(eq(trackerSchema.activities.workItemId, id));
}

// ============================================================================
// runs 行回填(依赖 F8 backfillWorkItemRun,已单测覆盖;这里覆盖窄 action 的
// 调用身份门 + 幂等透传 + 活动记录)。
// ============================================================================
describe("writeback-run-meta — runs 行回填", () => {
  it("attaches runId/branch to the current live dispatch row + writes a writeback.run-meta activity", async () => {
    await recordDispatchRun(db as any, {
      workItemId: "wi-1",
      threadId: "bt_1",
      ownerEmail: OWNER,
      orgId: ORG_ID,
      dispatchedAt: "2026-01-01T00:00:00Z",
    });

    const result = await asWriteback(() =>
      writebackRunMeta.run(
        {
          workItemId: "wi-1",
          runId: "run_abc",
          branch: "orchestrator/wi-1-fix",
        },
        mcpCtx(),
      ),
    );
    expect(result.updated).toBe(true);

    const runs = await fetchRuns("wi-1");
    expect(runs[0]!.runId).toBe("run_abc");
    expect(runs[0]!.branch).toBe("orchestrator/wi-1-fix");

    const acts = await fetchActivities("wi-1");
    expect(acts).toHaveLength(1);
    expect(acts[0]!.eventType).toBe("writeback.run-meta");
  });

  it("T-F9-02 style 幂等: repeat backfill of the SAME runId is a no-op the second time — zero new activity rows", async () => {
    await recordDispatchRun(db as any, {
      workItemId: "wi-1",
      threadId: "bt_1",
      ownerEmail: OWNER,
      orgId: ORG_ID,
      dispatchedAt: "2026-01-01T00:00:00Z",
    });
    const first = await asWriteback(() =>
      writebackRunMeta.run({ workItemId: "wi-1", runId: "run_abc" }, mcpCtx()),
    );
    const second = await asWriteback(() =>
      writebackRunMeta.run({ workItemId: "wi-1", runId: "run_abc" }, mcpCtx()),
    );
    expect(first.updated).toBe(true);
    expect(second.updated).toBe(false);

    const runs = await fetchRuns("wi-1");
    expect(runs).toHaveLength(1); // still exactly one row
    expect(await fetchActivities("wi-1")).toHaveLength(1); // only the first call wrote one
  });

  it("R4a.3 L2: templateDeviation writes a SEPARATE workflow.template-deviation activity", async () => {
    await recordDispatchRun(db as any, {
      workItemId: "wi-1",
      threadId: "bt_1",
      ownerEmail: OWNER,
      orgId: ORG_ID,
      dispatchedAt: "2026-01-01T00:00:00Z",
    });

    const result = await asWriteback(() =>
      writebackRunMeta.run(
        {
          workItemId: "wi-1",
          runId: "run_dev",
          branch: "orchestrator/wi-1-fix",
          templateDeviation: {
            chosen: "quick-task",
            suggested: "sdlc-issue-pipeline",
            deviationReason: "改动仅 1 文件",
          },
        },
        mcpCtx(),
      ),
    );
    expect(result.updated).toBe(true);

    const acts = await fetchActivities("wi-1");
    expect(acts).toHaveLength(2);
    const deviationAct = acts.find(
      (a) => a.eventType === "workflow.template-deviation",
    );
    expect(deviationAct).toBeDefined();
    const payload = JSON.parse(deviationAct!.payload as string);
    expect(payload.chosen).toBe("quick-task");
    expect(payload.suggested).toBe("sdlc-issue-pipeline");
    expect(payload.deviationReason).toBe("改动仅 1 文件");
  });

  it("no templateDeviation → no workflow.template-deviation activity written", async () => {
    await recordDispatchRun(db as any, {
      workItemId: "wi-1",
      threadId: "bt_1",
      ownerEmail: OWNER,
      orgId: ORG_ID,
      dispatchedAt: "2026-01-01T00:00:00Z",
    });
    await asWriteback(() =>
      writebackRunMeta.run(
        { workItemId: "wi-1", runId: "run_nodev" },
        mcpCtx(),
      ),
    );
    const acts = await fetchActivities("wi-1");
    expect(
      acts.some((a) => a.eventType === "workflow.template-deviation"),
    ).toBe(false);
  });

  it("陈旧(已被取代)runId 回写 — 零写入, 无当前活跃行可挂", async () => {
    // No dispatch row at all for this runId to attach to.
    const result = await asWriteback(() =>
      writebackRunMeta.run(
        { workItemId: "wi-1", runId: "run_orphan" },
        mcpCtx(),
      ),
    );
    expect(result.updated).toBe(false);
    expect(await fetchRuns("wi-1")).toHaveLength(0);
    expect(await fetchActivities("wi-1")).toHaveLength(0);
  });
});

// ============================================================================
// T-F9-05: 非回写身份调窄 action.
// ============================================================================
describe("T-F9-05: 非回写身份调 writeback-run-meta", () => {
  it("human (frontend) → rejected, zero writes", async () => {
    await recordDispatchRun(db as any, {
      workItemId: "wi-1",
      threadId: "bt_1",
      ownerEmail: OWNER,
      orgId: ORG_ID,
      dispatchedAt: "2026-01-01T00:00:00Z",
    });
    await expect(
      asUser(() =>
        writebackRunMeta.run(
          { workItemId: "wi-1", runId: "run_x" },
          { caller: "frontend" },
        ),
      ),
    ).rejects.toMatchObject({ code: "actor-denied" });
    expect(await fetchRuns("wi-1")).toHaveLength(1);
    expect(await fetchRuns("wi-1")).not.toHaveLength(0);
    const runs = await fetchRuns("wi-1");
    expect(runs[0]!.runId).toBeNull(); // untouched
    expect(await fetchActivities("wi-1")).toHaveLength(0);
  });

  it("agent tool-loop call (caller='tool') → rejected", async () => {
    await expect(
      asUser(() =>
        writebackRunMeta.run(
          { workItemId: "wi-1", runId: "run_x" },
          { caller: "tool" },
        ),
      ),
    ).rejects.toMatchObject({ code: "actor-denied" });
  });
});
