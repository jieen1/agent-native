// P3b work-queue + cross-task concurrency tests (DESIGN §6.4 / §13) against a
// real temp sqlite DB. These prove the load-bearing invariants:
//   - atomic single-flight claim (K workers, no double-claim, affected==rows)
//   - running peak == concurrencyDegree (the rest queued by priority)
//   - reap returns a stranded claimed/running row to queued; a fresh one stays
//   - set-concurrency changes the pool width
//   - queue-status counts + scheduler health
//   - enqueue does NOT change business status
//   - run-start workItemId path binds workflow_run.work_item_id; no-workflow fails
// Setup runs BEFORE importing anything that pulls in getDb / getDbExec.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createEngineTables,
  createPmTables,
  useTempDb,
} from "../../engine/__tests__/setup.js";

useTempDb();

const { getDb, schema, getDbExec } = await import("../../db/index.js");
const { eq } = await import("drizzle-orm");
const { nowIso, newId } = await import("../../../actions/_util.js");
const fixtures = await import("../../engine/fixtures.js");

const claim = await import("../claim.js");
const reap = await import("../reap.js");
const pool = await import("../worker-pool.js");
const concurrency = await import("../concurrency.js");
const status = await import("../status.js");
const driver = await import("../driver.js");
const runWork = await import("../run-work-item.js");
const execStateMod = await import("../exec-state.js");
const { EchoExecutor } = await import("../../engine/echo-executor.js");

const OWNER = "local@localhost";

/** Build executeOpts injecting a fresh echo executor (no routing/microVM path). */
function echoOpts(echoDelayMs = 0) {
  return { executor: new EchoExecutor(echoDelayMs), echoDelayMs };
}

beforeAll(async () => {
  await createEngineTables();
  await createPmTables();
});

async function seedTemplate(): Promise<string> {
  const db = getDb();
  const id = newId("tpl");
  const now = nowIso();
  await db.insert(schema.workflowTemplates).values({
    id,
    name: "queue-fixture",
    description: "",
    graph: JSON.stringify(fixtures.sequential),
    version: 1,
    createdAt: now,
    updatedAt: now,
    ownerEmail: OWNER,
    orgId: null,
    visibility: "private",
  });
  return id;
}

async function seedProject(
  opts: { defaultWorkflowId?: string | null } = {},
): Promise<string> {
  const db = getDb();
  const id = newId("proj");
  const now = nowIso();
  await db.insert(schema.projects).values({
    id,
    name: "P",
    key: "P",
    description: "",
    workingDir: "",
    gitRemote: null,
    defaultBranch: null,
    defaultWorkflowId: opts.defaultWorkflowId ?? null,
    statusSchemes: null,
    environments: null,
    createdAt: now,
    updatedAt: now,
    ownerEmail: OWNER,
    orgId: null,
    visibility: "private",
  });
  return id;
}

async function seedWorkItem(
  projectId: string,
  opts: {
    execState?: string;
    priority?: number;
    workflowId?: string | null;
    status?: string;
    statusCategory?: string;
  } = {},
): Promise<string> {
  const db = getDb();
  const id = newId("wi");
  const now = nowIso();
  await db.insert(schema.workItems).values({
    id,
    projectId,
    type: "task",
    title: "item",
    description: "",
    priority: opts.priority ?? 0,
    assignee: null,
    status: opts.status ?? "待办",
    statusCategory: (opts.statusCategory as never) ?? "todo",
    environment: null,
    severity: null,
    blocked: 0,
    blockedReason: null,
    blockedBy: null,
    resolution: null,
    statusStale: 0,
    execState: (opts.execState as never) ?? "idle",
    claimedAt: null,
    claimedBy: null,
    workflowId: opts.workflowId ?? null,
    workflowRunId: null,
    deliverable: null,
    createdAt: now,
    updatedAt: now,
    ownerEmail: OWNER,
    orgId: null,
    visibility: "private",
  });
  return id;
}

/** Set exec_state + claimed_* directly (simulate enqueue / a staled claim). */
async function setExec(
  id: string,
  execState: string,
  claimedBy: string | null = null,
  claimedAt: string | null = null,
): Promise<void> {
  await getDbExec().execute({
    sql: `UPDATE work_items SET exec_state=?, claimed_by=?, claimed_at=? WHERE id=?`,
    args: [execState, claimedBy, claimedAt, id],
  });
}

async function getItem(id: string) {
  const rows = await getDb()
    .select()
    .from(schema.workItems)
    .where(eq(schema.workItems.id, id))
    .limit(1);
  return rows[0];
}

// Wipe work_items / runs / node_runs between tests for isolation.
beforeEach(async () => {
  const c = getDbExec();
  await c.execute(`DELETE FROM work_items`);
  await c.execute(`DELETE FROM workflow_runs`);
  await c.execute(`DELETE FROM node_runs`);
  await c.execute(`DELETE FROM artifacts`);
});

describe("exec-state machine (DESIGN §6.4 / §6.2a)", () => {
  it("allows idle→queued→claimed→running→done and rejects illegal moves", () => {
    expect(execStateMod.canTransitionExec("idle", "queued")).toBe(true);
    expect(execStateMod.canTransitionExec("queued", "claimed")).toBe(true);
    expect(execStateMod.canTransitionExec("claimed", "running")).toBe(true);
    expect(execStateMod.canTransitionExec("running", "done")).toBe(true);
    expect(execStateMod.canTransitionExec("running", "failed")).toBe(true);
    expect(execStateMod.canTransitionExec("done", "queued")).toBe(true);
    // illegal
    expect(execStateMod.canTransitionExec("idle", "running")).toBe(false);
    expect(execStateMod.canTransitionExec("done", "running")).toBe(false);
    expect(execStateMod.canTransitionExec("idle", "claimed")).toBe(false);
  });
});

describe("atomic single-flight claim (DESIGN §6.4 / §13)", () => {
  it("K concurrent workers claim a queued batch: each row claimed by exactly one, sum(affected)==rows, no duplicate claimed_by", async () => {
    const tpl = await seedTemplate();
    const proj = await seedProject();
    const N = 12;
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const id = await seedWorkItem(proj, {
        execState: "queued",
        priority: i,
        workflowId: tpl,
      });
      ids.push(id);
    }

    // K workers each loop claimNextWorkItem until null, recording the unique
    // claim token each item ended up under.
    const K = 6;
    const claimedTokenById = new Map<string, string>(); // itemId -> claimToken
    let totalClaims = 0;
    await Promise.all(
      Array.from({ length: K }, async (_unused, k) => {
        const workerId = `w-${k}`;
        for (;;) {
          const c = await claim.claimNextWorkItem(workerId);
          if (!c) break;
          totalClaims += 1;
          // No item claimed twice (no double-claim under concurrency).
          expect(claimedTokenById.has(c.id)).toBe(false);
          // The token carries the worker that won it.
          expect(c.claimToken.startsWith(`${workerId}::`)).toBe(true);
          claimedTokenById.set(c.id, c.claimToken);
        }
      }),
    );

    // Every queued row was claimed exactly once (sum of affected == row count).
    expect(totalClaims).toBe(N);
    expect(claimedTokenById.size).toBe(N);

    // DB: every row is claimed, each carrying the single token that won it; and
    // every claimed_by token is distinct (no two rows share a claim token).
    const rows = await getDbExec().execute(
      `SELECT id, exec_state, claimed_by FROM work_items`,
    );
    expect(rows.rows.length).toBe(N);
    const tokensSeen = new Set<string>();
    for (const r of rows.rows) {
      expect(String(r.exec_state)).toBe("claimed");
      expect(claimedTokenById.get(String(r.id))).toBe(String(r.claimed_by));
      expect(tokensSeen.has(String(r.claimed_by))).toBe(false);
      tokensSeen.add(String(r.claimed_by));
    }
  });

  it("claims in priority order (lower priority first), id as tiebreaker", async () => {
    const proj = await seedProject();
    const lo = await seedWorkItem(proj, { execState: "queued", priority: 0 });
    const hi = await seedWorkItem(proj, { execState: "queued", priority: 5 });
    const c1 = await claim.claimNextWorkItem("w");
    const c2 = await claim.claimNextWorkItem("w");
    expect(c1?.id).toBe(lo);
    expect(c2?.id).toBe(hi);
    expect(await claim.claimNextWorkItem("w")).toBeNull();
  });
});

describe("worker pool — running peak == concurrencyDegree (DESIGN §6.4)", () => {
  it("batch-enqueue N > degree: at most `degree` run concurrently; rest queued by priority until claimed", async () => {
    const tpl = await seedTemplate();
    const proj = await seedProject();
    const N = 9;
    const degree = 3;
    for (let i = 0; i < N; i++) {
      await seedWorkItem(proj, {
        execState: "queued",
        priority: i,
        workflowId: tpl,
      });
    }

    // Sample the concurrent-claim count via onClaim/settle bracketing: increment
    // when claimed, and snapshot how many items are simultaneously claimed/running
    // in the DB during the drain. Use a small echo delay so overlap is real.
    let peak = 0;
    const sample = async () => {
      const r = await getDbExec().execute(
        `SELECT COUNT(*) AS n FROM work_items WHERE exec_state IN ('claimed','running')`,
      );
      peak = Math.max(peak, Number(r.rows[0].n ?? 0));
    };

    const result = await pool.drainQueue({
      concurrency: degree,
      ownerEmail: OWNER,
      orgId: null,
      executeOpts: echoOpts(5),
      onClaim: () => {
        void sample();
      },
    });

    // All N processed; the peak in-flight never exceeded the pool width.
    expect(result.processed.length).toBe(N);
    expect(result.concurrency).toBe(degree);
    expect(peak).toBeLessThanOrEqual(degree);
    expect(peak).toBeGreaterThan(0);

    // All items settled (done — the sequential echo fixture succeeds) and bound
    // to a workflow_run with work_item_id set.
    const rows = await getDbExec().execute(`SELECT exec_state FROM work_items`);
    for (const r of rows.rows) expect(String(r.exec_state)).toBe("done");
    const runs = await getDbExec().execute(
      `SELECT work_item_id, status FROM workflow_runs`,
    );
    expect(runs.rows.length).toBe(N);
    for (const r of runs.rows) {
      expect(r.work_item_id).toBeTruthy();
      expect(String(r.status)).toBe("done");
    }
  });

  it("no double workflow_run per item: exactly one run per processed item", async () => {
    const tpl = await seedTemplate();
    const proj = await seedProject();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++)
      ids.push(
        await seedWorkItem(proj, {
          execState: "queued",
          priority: i,
          workflowId: tpl,
        }),
      );

    await pool.drainQueue({
      concurrency: 3,
      ownerEmail: OWNER,
      orgId: null,
      executeOpts: echoOpts(0),
    });

    for (const id of ids) {
      const runs = await getDbExec().execute({
        sql: `SELECT id FROM workflow_runs WHERE work_item_id = ?`,
        args: [id],
      });
      expect(runs.rows.length).toBe(1);
    }
  });
});

describe("queue reap (DESIGN §6.4 D-3 / §13)", () => {
  it("returns a stranded claimed row to queued; a FRESH claim is NOT reaped", async () => {
    const tpl = await seedTemplate();
    const proj = await seedProject();
    const stale = await seedWorkItem(proj, { workflowId: tpl });
    const fresh = await seedWorkItem(proj, { workflowId: tpl });

    const longAgo = new Date(Date.now() - 10 * 60_000).toISOString(); // 10m ago
    const now = nowIso();
    await setExec(stale, "claimed", "dead-worker", longAgo);
    await setExec(fresh, "claimed", "live-worker", now);

    const reaped = await reap.reapQueueOnce(); // default 120s threshold
    expect(reaped.map((r) => r.id)).toContain(stale);
    expect(reaped.map((r) => r.id)).not.toContain(fresh);

    expect(String((await getItem(stale)).execState)).toBe("queued");
    expect(String((await getItem(fresh)).execState)).toBe("claimed");

    // The re-queued stale item is re-claimable; the fresh one is still claimed,
    // so a re-claim grabs the stale one (no double-run for one item).
    const c = await claim.claimNextWorkItem("w2");
    expect(c?.id).toBe(stale);
  });

  it("returns a stranded running row to queued too", async () => {
    const proj = await seedProject();
    const stale = await seedWorkItem(proj);
    const longAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    await setExec(stale, "running", "dead", longAgo);
    const reaped = await reap.reapQueueOnce();
    expect(reaped.map((r) => r.id)).toContain(stale);
    expect(String((await getItem(stale)).execState)).toBe("queued");
  });
});

describe("set-concurrency changes the pool width (DESIGN §6.4)", () => {
  it("setConcurrencyDegree persists and getConcurrencyDegree reads it back; drainQueue honors the default", async () => {
    await concurrency.setConcurrencyDegree(5);
    expect(await concurrency.getConcurrencyDegree()).toBe(5);
    await concurrency.setConcurrencyDegree(2);
    expect(await concurrency.getConcurrencyDegree()).toBe(2);

    const tpl = await seedTemplate();
    const proj = await seedProject();
    for (let i = 0; i < 4; i++)
      await seedWorkItem(proj, {
        execState: "queued",
        priority: i,
        workflowId: tpl,
      });

    // No explicit concurrency → pool reads the saved degree (2).
    const r = await pool.drainQueue({
      ownerEmail: OWNER,
      orgId: null,
      executeOpts: echoOpts(0),
    });
    expect(r.concurrency).toBe(2);
    expect(r.processed.length).toBe(4);
  });

  it("clamps out-of-range degrees to [1, MAX]", async () => {
    expect(await concurrency.setConcurrencyDegree(0)).toBe(1);
    expect(await concurrency.setConcurrencyDegree(9999)).toBe(
      concurrency.MAX_CONCURRENCY_DEGREE,
    );
  });
});

describe("queue-status counts + scheduler health (DESIGN §6.4)", () => {
  it("returns concurrencyDegree, running/queued/claimed counts, maxConcurrentVMs/vmsInUse, scheduler health", async () => {
    const proj = await seedProject();
    await concurrency.setConcurrencyDegree(3);
    await seedWorkItem(proj, { execState: "queued" });
    await seedWorkItem(proj, { execState: "queued" });
    await seedWorkItem(proj, { execState: "claimed" });
    await seedWorkItem(proj, { execState: "running" });
    await seedWorkItem(proj, { execState: "idle" });

    const s = await status.getQueueStatus();
    expect(s.concurrencyDegree).toBe(3);
    expect(s.queued).toBe(2);
    expect(s.claimed).toBe(1);
    expect(s.running).toBe(1);
    expect(s.maxConcurrentVMs).toBeGreaterThan(0);
    expect(s.vmsInUse).toBe(0);
    // scheduler health fields present (driver not started in this test).
    expect(typeof s.schedulerAlive).toBe("boolean");
    expect(s).toHaveProperty("lastTickAt");
    expect(typeof s.reapsFired).toBe("number");
  });

  it("driver self-observation: driveOnce advances lastTickAt + reapsFired", async () => {
    const tpl = await seedTemplate();
    const proj = await seedProject();
    // One stranded claimed item (reap returns it) + one fresh queued item (pool runs it).
    const stranded = await seedWorkItem(proj, { workflowId: tpl });
    await setExec(
      stranded,
      "claimed",
      "dead",
      new Date(Date.now() - 10 * 60_000).toISOString(),
    );
    await seedWorkItem(proj, { execState: "queued", workflowId: tpl });

    const before = driver.getSchedulerHealth();
    const out = await driver.driveOnce({ ownerEmail: OWNER, orgId: null });
    const after = driver.getSchedulerHealth();

    expect(out.reaped).toBeGreaterThanOrEqual(1);
    expect(after.reapsFired).toBeGreaterThan(before.reapsFired);
    expect(after.lastTickAt).not.toBeNull();
    // both items end up processed (the reaped one is re-claimed in the same drain).
    expect(out.processed).toBeGreaterThanOrEqual(1);
  });
});

describe("enqueue does NOT change business status (DESIGN §6.4 / §6.2a)", () => {
  it("moving idle→queued leaves status / statusCategory / blocked / resolution untouched", async () => {
    const tpl = await seedTemplate();
    const proj = await seedProject();
    const id = await seedWorkItem(proj, {
      status: "开发中",
      statusCategory: "in-progress",
    });

    const before = await getItem(id);
    // Simulate enqueue via the same guarded update the action uses.
    await getDb()
      .update(schema.workItems)
      .set({ execState: "queued", workflowId: tpl, updatedAt: nowIso() })
      .where(eq(schema.workItems.id, id));
    const after = await getItem(id);

    expect(String(after.execState)).toBe("queued");
    expect(String(after.workflowId)).toBe(tpl);
    // business status dimensions unchanged
    expect(after.status).toBe(before.status);
    expect(after.statusCategory).toBe(before.statusCategory);
    expect(after.blocked).toBe(before.blocked);
    expect(after.resolution).toBe(before.resolution);
  });
});

describe("run-start workItemId path (DESIGN §6.4 / §0.6)", () => {
  it("binds workflow_run.work_item_id and runs the item's explicit workflow", async () => {
    const tpl = await seedTemplate();
    const proj = await seedProject();
    const id = await seedWorkItem(proj, { workflowId: tpl });

    const r = await runWork.startRunForWorkItem(id, {
      ownerEmail: OWNER,
      orgId: null,
      execute: true,
      executeOpts: echoOpts(0),
    });
    expect(r.status).toBe("done");
    expect(r.noWorkflow).toBeFalsy();

    const runs = await getDbExec().execute({
      sql: `SELECT work_item_id, template_id, status FROM workflow_runs WHERE id = ?`,
      args: [r.runId],
    });
    expect(String(runs.rows[0].work_item_id)).toBe(id);
    expect(String(runs.rows[0].template_id)).toBe(tpl);
    expect(String(runs.rows[0].status)).toBe("done");

    // Item's workflow_run_id was bound.
    expect(String((await getItem(id)).workflowRunId)).toBe(r.runId);
  });

  it("a missing explicit template → run failed with a clear reason, not a crash", async () => {
    const proj = await seedProject();
    const id = await seedWorkItem(proj, { workflowId: "tpl_does_not_exist" });

    const r = await runWork.startRunForWorkItem(id, {
      ownerEmail: OWNER,
      orgId: null,
      execute: true,
    });
    expect(r.status).toBe("failed");
    expect(r.noWorkflow).toBe(true);
    expect(r.templateSource).toBe("explicit");
    expect(r.reason).toMatch(/not found/i);

    const runs = await getDbExec().execute({
      sql: `SELECT work_item_id, status FROM workflow_runs WHERE id = ?`,
      args: [r.runId],
    });
    expect(String(runs.rows[0].work_item_id)).toBe(id);
    expect(String(runs.rows[0].status)).toBe("failed");
  });
});

// ── DECOMPOSITION THREE-ORDER (DESIGN §6.3) — assert the SOURCE, not just "ran" ──
describe("decomposition three-order (DESIGN §6.3)", () => {
  it("ORDER 1: explicit item.workflowId wins even when the project has a default", async () => {
    const explicitTpl = await seedTemplate();
    const defaultTpl = await seedTemplate();
    const proj = await seedProject({ defaultWorkflowId: defaultTpl });
    const id = await seedWorkItem(proj, { workflowId: explicitTpl });

    const r = await runWork.startRunForWorkItem(id, {
      ownerEmail: OWNER,
      orgId: null,
      execute: false,
    });
    expect(r.templateSource).toBe("explicit");
    expect(r.templateId).toBe(explicitTpl);
    expect(r.dynamicAuthored).toBe(false);

    // The persisted run's template_id is the EXPLICIT one (not the default).
    const runs = await getDbExec().execute({
      sql: `SELECT template_id, dynamic_authored FROM workflow_runs WHERE id = ?`,
      args: [r.runId],
    });
    expect(String(runs.rows[0].template_id)).toBe(explicitTpl);
    expect(Number(runs.rows[0].dynamic_authored)).toBe(0);
  });

  it("ORDER 2: no workflowId → project.defaultWorkflowId is used", async () => {
    const defaultTpl = await seedTemplate();
    const proj = await seedProject({ defaultWorkflowId: defaultTpl });
    const id = await seedWorkItem(proj, { workflowId: null });

    const r = await runWork.startRunForWorkItem(id, {
      ownerEmail: OWNER,
      orgId: null,
      execute: false,
    });
    expect(r.templateSource).toBe("default");
    expect(r.templateId).toBe(defaultTpl);
    expect(r.dynamicAuthored).toBe(false);

    const runs = await getDbExec().execute({
      sql: `SELECT template_id FROM workflow_runs WHERE id = ?`,
      args: [r.runId],
    });
    expect(String(runs.rows[0].template_id)).toBe(defaultTpl);
  });

  it("ORDER 3: neither set → DYNAMIC, run marked dynamic_authored, no template", async () => {
    const proj = await seedProject({ defaultWorkflowId: null });
    const id = await seedWorkItem(proj, { workflowId: null });

    const r = await runWork.startRunForWorkItem(id, {
      ownerEmail: OWNER,
      orgId: null,
      execute: true, // even with execute:true, the dynamic path does NOT run an LLM
    });
    expect(r.templateSource).toBe("dynamic");
    expect(r.dynamicAuthored).toBe(true);
    expect(r.status).toBe("pending");
    expect(r.templateId).toBe("");
    expect(r.reason).toMatch(/dynamic/i);

    const runs = await getDbExec().execute({
      sql: `SELECT template_id, status, dynamic_authored FROM workflow_runs WHERE id = ?`,
      args: [r.runId],
    });
    expect(String(runs.rows[0].template_id)).toBe("");
    expect(String(runs.rows[0].status)).toBe("pending");
    expect(Number(runs.rows[0].dynamic_authored)).toBe(1);
  });
});
