// P3a DB-backed tests: the reconciliation watchdog (DESIGN §6.2b L2) and the
// v1→v2 backfill (DESIGN §9). Run against a real temp libsql DB (same harness as
// the engine tests). The watchdog is a pure DB function so it needs no request
// context; the backfill is called directly with an explicit owner.

import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createEngineTables,
  createPmTables,
  useTempDb,
} from "../../engine/__tests__/setup.js";

useTempDb();

const { getDb, schema } = await import("../../db/index.js");
const { reconcileOnTerminal } = await import("../watchdog.js");
const { backfillTasksForOwner, backfillWorkItemId } =
  await import("../backfill.js");
const { nowIso, newId } = await import("../../../actions/_util.js");

beforeAll(async () => {
  await createEngineTables();
  await createPmTables();
});

const OWNER = "local@localhost";

async function makeProjectAndItem(opts: {
  status: string;
  statusCategory: "todo" | "in-progress" | "completed" | "cancelled";
}): Promise<{ projectId: string; itemId: string }> {
  const db = getDb();
  const now = nowIso();
  const projectId = newId("proj");
  await db.insert(schema.projects).values({
    id: projectId,
    name: "P",
    key: "P",
    createdAt: now,
    updatedAt: now,
    ownerEmail: OWNER,
    orgId: null,
    visibility: "private",
  });
  const itemId = newId("wi");
  await db.insert(schema.workItems).values({
    id: itemId,
    projectId,
    type: "task",
    title: "T",
    status: opts.status,
    statusCategory: opts.statusCategory,
    createdAt: now,
    updatedAt: now,
    ownerEmail: OWNER,
    orgId: null,
    visibility: "private",
  });
  return { projectId, itemId };
}

type RunStatus =
  | "pending"
  | "running"
  | "paused"
  | "done"
  | "failed"
  | "cancelled";

async function makeRun(
  workItemId: string | null,
  status: RunStatus,
): Promise<string> {
  const db = getDb();
  const now = nowIso();
  const runId = newId("run");
  await db.insert(schema.workflowRuns).values({
    id: runId,
    templateId: "tpl_x",
    workItemId,
    status,
    tokensSpent: 0,
    startedAt: now,
    completedAt: status === "done" || status === "failed" ? now : null,
    ownerEmail: OWNER,
    orgId: null,
    visibility: "private",
  });
  return runId;
}

describe("watchdog: reconcileOnTerminal (DESIGN §6.2b L2)", () => {
  it("flags status_stale when a bound run finished with NO status change", async () => {
    const { itemId } = await makeProjectAndItem({
      status: "进行中",
      statusCategory: "in-progress",
    });
    const runId = await makeRun(itemId, "done");

    const res = await reconcileOnTerminal(runId);
    expect(res.checked).toBe(true);
    expect(res.statusChanged).toBe(false);
    expect(res.flaggedStale).toBe(true);

    const db = getDb();
    const rows = await db
      .select({ statusStale: schema.workItems.statusStale })
      .from(schema.workItems)
      .where(eq(schema.workItems.id, itemId));
    expect(rows[0].statusStale).toBe(1);
  });

  it("does NOT flag when a status change WAS logged during the run", async () => {
    const { itemId } = await makeProjectAndItem({
      status: "待发布",
      statusCategory: "in-progress",
    });
    const runId = await makeRun(itemId, "done");
    const db = getDb();
    // A real stage move logged for this run (from != to).
    await db.insert(schema.workItemStatusLog).values({
      id: newId("wisl"),
      workItemId: itemId,
      runId,
      actor: runId,
      fromStatus: "进行中",
      toStatus: "待发布",
      blocked: 0,
      resolution: null,
      at: nowIso(),
    });

    const res = await reconcileOnTerminal(runId);
    expect(res.checked).toBe(true);
    expect(res.statusChanged).toBe(true);
    expect(res.flaggedStale).toBe(false);

    const rows = await db
      .select({ statusStale: schema.workItems.statusStale })
      .from(schema.workItems)
      .where(eq(schema.workItems.id, itemId));
    expect(rows[0].statusStale).toBe(0);
  });

  it("a blocked-only log row (from == to) does NOT count as a status change", async () => {
    const { itemId } = await makeProjectAndItem({
      status: "进行中",
      statusCategory: "in-progress",
    });
    const runId = await makeRun(itemId, "done");
    const db = getDb();
    await db.insert(schema.workItemStatusLog).values({
      id: newId("wisl"),
      workItemId: itemId,
      runId,
      actor: runId,
      fromStatus: "进行中",
      toStatus: "进行中", // a pure blocked write — same stage
      blocked: 1,
      resolution: null,
      at: nowIso(),
    });
    const res = await reconcileOnTerminal(runId);
    expect(res.flaggedStale).toBe(true);
  });

  it("EXEMPTS a run with no bound work item (checked=false)", async () => {
    const runId = await makeRun(null, "done");
    const res = await reconcileOnTerminal(runId);
    expect(res.checked).toBe(false);
    expect(res.flaggedStale).toBe(false);
  });

  it("does not reconcile a non-terminal (paused/running) run", async () => {
    const { itemId } = await makeProjectAndItem({
      status: "进行中",
      statusCategory: "in-progress",
    });
    const runId = await makeRun(itemId, "paused");
    const res = await reconcileOnTerminal(runId);
    expect(res.checked).toBe(false);
    expect(res.flaggedStale).toBe(false);
  });
});

describe("backfill: v1 tasks → v2 work items (DESIGN §9)", () => {
  it("copies tasks, is idempotent, and never mutates v1 rows", async () => {
    const db = getDb();
    const now = nowIso();
    // Two v1 tasks for the owner, one done + one pending.
    const taskA = newId("task");
    const taskB = newId("task");
    await db.insert(schema.tasks).values([
      {
        id: taskA,
        title: "Task A",
        description: "desc A",
        status: "done",
        workflowId: null,
        result: "A result",
        createdAt: now,
        updatedAt: now,
        ownerEmail: OWNER,
        orgId: null,
        visibility: "private",
      },
      {
        id: taskB,
        title: "Task B",
        description: "",
        status: "pending",
        workflowId: null,
        result: null,
        createdAt: now,
        updatedAt: now,
        ownerEmail: OWNER,
        orgId: null,
        visibility: "private",
      },
    ]);

    // Snapshot the v1 rows to prove byte-stability.
    const beforeTasks = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.ownerEmail, OWNER));
    const beforeJson = JSON.stringify(beforeTasks);

    const first = await backfillTasksForOwner(OWNER, null);
    expect(first.created).toBeGreaterThanOrEqual(2);
    // Deterministic id mapping.
    const wiA = await db
      .select()
      .from(schema.workItems)
      .where(eq(schema.workItems.id, backfillWorkItemId(taskA)));
    expect(wiA.length).toBe(1);
    expect(wiA[0].title).toBe("Task A");
    expect(wiA[0].statusCategory).toBe("completed");
    expect(wiA[0].resolution).toBe("shipped");
    const wiB = await db
      .select()
      .from(schema.workItems)
      .where(eq(schema.workItems.id, backfillWorkItemId(taskB)));
    expect(wiB[0].statusCategory).toBe("todo");

    // Idempotent: a second run creates 0 new rows.
    const countBefore = (await db.select().from(schema.workItems)).length;
    const second = await backfillTasksForOwner(OWNER, null);
    expect(second.created).toBe(0);
    const countAfter = (await db.select().from(schema.workItems)).length;
    expect(countAfter).toBe(countBefore);

    // v1 tasks unchanged byte-for-byte.
    const afterTasks = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.ownerEmail, OWNER));
    expect(JSON.stringify(afterTasks)).toBe(beforeJson);
  });
});
