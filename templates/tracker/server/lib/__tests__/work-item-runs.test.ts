import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createClient, type Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import * as trackerSchema from "../../db/schema.js";
import {
  backfillWorkItemRun,
  listWorkItemRuns,
  recordDispatchRun,
} from "../work-item-runs.js";

// ============================================================================
// F8 回链完整性: server/lib/work-item-runs.ts
//
// T-F8-03: 追加式 run 历史 — 派发 -> 取消 -> 重派 (模拟 B2) produces TWO rows
//          in tracker_work_item_runs, the prior one superseded=1, never an
//          in-place UPDATE of the old row's thread/branch (SDLC-053).
// T-F8-04: UNIQUE(work_item_id, run_id) 幂等回写不重复 — backfilling the
//          same runId twice is a no-op the second time, still exactly one
//          row carries that runId.
// T-F8-07: 旧列兼容 — orchestratorRunId (the pre-F8 column) stays in sync
//          with the latest backfilled run.
// ============================================================================

let client: Client;
let db: LibSQLDatabase<typeof trackerSchema>;
let dbDir: string;

const OWNER = "owner@example.com";
const ORG_ID = "org-f8";

beforeEach(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "work-item-runs-"));
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
  `);
  await db.insert(trackerSchema.workItems).values({
    id: "wi-1",
    projectId: "proj-1",
    itemKey: "F8-001",
    title: "t",
    description: "",
    status: "open",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ownerEmail: OWNER,
    orgId: ORG_ID,
  } as any);
});

afterAll(() => {
  client?.close();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

describe("recordDispatchRun — T-F8-03 追加式 run 历史", () => {
  it("first dispatch inserts exactly one live (superseded=0) row", async () => {
    await recordDispatchRun(db as any, {
      workItemId: "wi-1",
      threadId: "bt_1",
      ownerEmail: OWNER,
      orgId: ORG_ID,
      dispatchedAt: "2026-01-01T00:00:00Z",
    });
    const runs = await listWorkItemRuns(db as any, "wi-1");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.threadId).toBe("bt_1");
    expect(runs[0]!.superseded).toBe(false);
    expect(runs[0]!.runId).toBeNull();
  });

  it("派发 -> 取消 -> 重派 (B2): a second dispatch marks the first row superseded and adds a NEW row — never an in-place overwrite", async () => {
    await recordDispatchRun(db as any, {
      workItemId: "wi-1",
      threadId: "bt_first",
      ownerEmail: OWNER,
      orgId: ORG_ID,
      dispatchedAt: "2026-01-01T00:00:00Z",
    });
    // ... simulated cancel happens out-of-band (execState -> queued; no run
    // row change) ...
    await recordDispatchRun(db as any, {
      workItemId: "wi-1",
      threadId: "bt_second",
      ownerEmail: OWNER,
      orgId: ORG_ID,
      dispatchedAt: "2026-01-02T00:00:00Z",
    });

    const runs = await listWorkItemRuns(db as any, "wi-1");
    expect(runs).toHaveLength(2); // T-F8-03: get-work-item.runs length 2
    // Newest-first ordering.
    expect(runs[0]!.threadId).toBe("bt_second");
    expect(runs[0]!.superseded).toBe(false);
    expect(runs[1]!.threadId).toBe("bt_first");
    expect(runs[1]!.superseded).toBe(true); // old row superseded=1, NOT deleted/overwritten
  });

  it("a third redispatch keeps the full 3-row history, only the newest is live", async () => {
    for (const [threadId, at] of [
      ["bt_1", "2026-01-01T00:00:00Z"],
      ["bt_2", "2026-01-02T00:00:00Z"],
      ["bt_3", "2026-01-03T00:00:00Z"],
    ] as const) {
      await recordDispatchRun(db as any, {
        workItemId: "wi-1",
        threadId,
        ownerEmail: OWNER,
        orgId: ORG_ID,
        dispatchedAt: at,
      });
    }
    const runs = await listWorkItemRuns(db as any, "wi-1");
    expect(runs).toHaveLength(3);
    expect(runs.filter((r) => !r.superseded)).toHaveLength(1);
    expect(runs.filter((r) => !r.superseded)[0]!.threadId).toBe("bt_3");
  });
});

describe("backfillWorkItemRun — T-F8-04 幂等回写 + T-F8-07 旧列兼容", () => {
  it("attaches runId/branch to the current live dispatch row", async () => {
    await recordDispatchRun(db as any, {
      workItemId: "wi-1",
      threadId: "bt_1",
      ownerEmail: OWNER,
      orgId: ORG_ID,
      dispatchedAt: "2026-01-01T00:00:00Z",
    });
    const { updated } = await backfillWorkItemRun(db as any, {
      workItemId: "wi-1",
      runId: "run_abc",
      branch: "orchestrator/wi-1-fix",
      ownerEmail: OWNER,
      orgId: ORG_ID,
    });
    expect(updated).toBe(true);

    const runs = await listWorkItemRuns(db as any, "wi-1");
    expect(runs[0]!.runId).toBe("run_abc");
    expect(runs[0]!.branch).toBe("orchestrator/wi-1-fix");
  });

  it("T-F8-04: backfilling the SAME runId twice is a no-op the second time — still exactly one row", async () => {
    await recordDispatchRun(db as any, {
      workItemId: "wi-1",
      threadId: "bt_1",
      ownerEmail: OWNER,
      orgId: ORG_ID,
      dispatchedAt: "2026-01-01T00:00:00Z",
    });
    const first = await backfillWorkItemRun(db as any, {
      workItemId: "wi-1",
      runId: "run_abc",
      branch: "orchestrator/wi-1-fix",
      ownerEmail: OWNER,
      orgId: ORG_ID,
    });
    const second = await backfillWorkItemRun(db as any, {
      workItemId: "wi-1",
      runId: "run_abc",
      branch: "orchestrator/wi-1-fix",
      ownerEmail: OWNER,
      orgId: ORG_ID,
    });
    expect(first.updated).toBe(true);
    expect(second.updated).toBe(false); // no-op — already recorded under this runId

    const runs = await listWorkItemRuns(db as any, "wi-1");
    expect(runs).toHaveLength(1); // still exactly one row, not duplicated
    expect(runs[0]!.runId).toBe("run_abc");
  });

  it("T-F8-07: mirrors the backfilled runId onto work_items.orchestratorRunId (old column, kept in sync)", async () => {
    await recordDispatchRun(db as any, {
      workItemId: "wi-1",
      threadId: "bt_1",
      ownerEmail: OWNER,
      orgId: ORG_ID,
      dispatchedAt: "2026-01-01T00:00:00Z",
    });
    await backfillWorkItemRun(db as any, {
      workItemId: "wi-1",
      runId: "run_abc",
      branch: "orchestrator/wi-1-fix",
      ownerEmail: OWNER,
      orgId: ORG_ID,
    });

    const item = (
      await db
        .select()
        .from(trackerSchema.workItems)
        .where(eq(trackerSchema.workItems.id, "wi-1"))
    )[0]!;
    const runs = await listWorkItemRuns(db as any, "wi-1");
    // T-F8-07: 值=最新 run, 与 runs[0] 一致.
    expect((item as any).orchestratorRunId).toBe(runs[0]!.runId);
    expect((item as any).branch).toBe(runs[0]!.branch);
  });

  it("returns updated=false when there is no live (unbackfilled) row to attach to", async () => {
    // No dispatch ever happened for this item.
    const { updated } = await backfillWorkItemRun(db as any, {
      workItemId: "wi-1",
      runId: "run_orphan",
      ownerEmail: OWNER,
      orgId: ORG_ID,
    });
    expect(updated).toBe(false);
  });
});
