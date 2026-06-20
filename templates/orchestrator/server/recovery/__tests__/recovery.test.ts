// P6 CRASH-RECOVERY + AUDIT + TERMINAL-CLOSURE tests (DESIGN §14 / §1.7 / §6.2b /
// §7.4.7). Against a real temp sqlite DB. Proves the P6 acceptance items:
//
//   (a) a workflow_run left `running` with a mix of done + running NodeRuns is
//       re-driven: done NodeRuns are NOT re-run (attempts unchanged, executor
//       not re-invoked for them — the journal replay), the stranded `running`
//       NodeRun is re-driven to done.
//   (b) a work_item left `claimed` past the heartbeat is returned to `queued`
//       and re-claimed by EXACTLY ONE worker (no two active runs for one item).
//   (c) every reaped row leaves an audit trail (no silent loss).
//   (d) a control action + a transition write audit rows.
//   (e) the PR-merge webhook moves an item to its terminal stage + resolution:shipped.
//
// Setup runs BEFORE importing anything that pulls in getDb.

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
const { Scheduler } = await import("../../engine/scheduler.js");
const { DEFAULT_CAPS } = await import("../../engine/types.js");
const { EchoExecutor } = await import("../../engine/echo-executor.js");
const recovery = await import("../reconcile.js");
const claim = await import("../../queue/claim.js");
const { applyTransition } = await import("../../work-items/transition.js");
const { cancelRun } = await import("../../engine/control.js");

import type { NodeExecutor, NodeExecutionInput, NodeExecutionResult, RunConfig } from "../../engine/types.js";
import type { WorkflowGraph } from "../../../shared/types.js";

const OWNER = "local@localhost";

/** A spy echo executor that records which journal keys it actually invoked. */
class SpyExecutor implements NodeExecutor {
  readonly kind = "spy";
  readonly invoked: string[] = [];
  async invoke(
    input: NodeExecutionInput,
    _signal: AbortSignal,
  ): Promise<NodeExecutionResult> {
    this.invoked.push(`${input.node.id}#${input.iteration}#${input.fanoutIndex}`);
    return { output: { node: input.node.id, deps: input.deps }, tokensSpent: 0 };
  }
}

beforeAll(async () => {
  await createEngineTables();
  await createPmTables();
});

beforeEach(async () => {
  const c = getDbExec();
  await c.execute(`DELETE FROM work_items`);
  await c.execute(`DELETE FROM workflow_runs`);
  await c.execute(`DELETE FROM node_runs`);
  await c.execute(`DELETE FROM artifacts`);
  await c.execute(`DELETE FROM work_item_status_log`);
  await c.execute(`DELETE FROM audit_log`);
});

async function seedTemplate(graph: WorkflowGraph = fixtures.sequential): Promise<string> {
  const db = getDb();
  const id = newId("tpl");
  const now = nowIso();
  await db.insert(schema.workflowTemplates).values({
    id, name: "t", description: "", graph: JSON.stringify(graph),
    version: 1, createdAt: now, updatedAt: now,
    ownerEmail: OWNER, orgId: null, visibility: "private",
  });
  return id;
}

async function seedRun(templateId: string, workItemId: string | null = null): Promise<string> {
  const db = getDb();
  const id = newId("run");
  const now = nowIso();
  await db.insert(schema.workflowRuns).values({
    id, templateId, workItemId, status: "pending", deliverable: null,
    tokenBudget: null, tokensSpent: 0, dynamicAuthored: 0,
    startedAt: now, completedAt: null,
    ownerEmail: OWNER, orgId: null, visibility: "private",
  });
  return id;
}

function makeCfg(runId: string, templateId: string, graph: WorkflowGraph): RunConfig {
  return {
    runId, templateId, graph, userEmail: OWNER, orgId: null,
    tokenBudget: null, seed: 1, caps: { ...DEFAULT_CAPS }, echoDelayMs: 0,
  };
}

async function nodeRunRow(runId: string, nodeId: string) {
  const rows = await getDb()
    .select()
    .from(schema.nodeRuns)
    .where(eq(schema.nodeRuns.runId, runId));
  return rows.find((r) => r.nodeId === nodeId);
}

// ── (a) crash recovery: done preserved, stranded running re-driven ────────────

describe("crash recovery (a): done NodeRuns NOT re-run, stranded running re-driven (§1.7)", () => {
  it("reconcile re-drives a running run; done nodes replay (executor not re-invoked), the stranded running node re-runs", async () => {
    const graph = fixtures.sequential; // start → a → b → c → end
    const tpl = await seedTemplate(graph);
    const runId = await seedRun(tpl);

    // Drive the run to completion ONCE so node_runs + output artifacts exist.
    const first = new SpyExecutor();
    const o1 = await new Scheduler({
      cfg: makeCfg(runId, tpl, graph), db: getDb(), executor: first,
    }).run();
    expect(o1.status).toBe("done");

    // Record the leaf nodes' attempts BEFORE the crash (a is a done leaf).
    const aBefore = await nodeRunRow(runId, "a");
    expect(aBefore?.status).toBe("done");
    const aAttemptsBefore = aBefore!.attempts;

    // SIMULATE A CRASH mid-run: node `b` was running when the isolate died, and
    // `c`+`end` had not run yet. Flip `b` → running (stranded), reset `c`/`end`
    // to pending, and the run row back to `running`. `start`/`a` stay done.
    await getDb().update(schema.nodeRuns)
      .set({ status: "running", outputRef: null, completedAt: null, lastHeartbeat: nowIso() })
      .where(eq(schema.nodeRuns.id, (await nodeRunRow(runId, "b"))!.id));
    for (const nid of ["c", "end"]) {
      await getDb().update(schema.nodeRuns)
        .set({ status: "pending", outputRef: null, completedAt: null })
        .where(eq(schema.nodeRuns.id, (await nodeRunRow(runId, nid))!.id));
    }
    await getDb().update(schema.workflowRuns)
      .set({ status: "running", completedAt: null })
      .where(eq(schema.workflowRuns.id, runId));

    // RECONCILE with a fresh spy → only the dirty tail should be invoked.
    const recoverSpy = new SpyExecutor();
    const result = await recovery.reconcileOnStartup({
      ownerEmail: OWNER, orgId: null, control: { executor: recoverSpy },
    });

    // One run recovered.
    expect(result.recoveredRuns.length).toBe(1);
    const rec = result.recoveredRuns[0];
    expect(rec.runId).toBe(runId);
    expect(rec.status).toBe("done");
    // The stranded `b` was reset (1 NodeRun reset running→pending).
    expect(rec.resetNodeRuns.some((n) => n.nodeId === "b")).toBe(true);
    // `start` + `a` were preserved done (replayed, NOT re-run).
    expect(rec.preservedDoneCount).toBeGreaterThanOrEqual(2);

    // THE KEY ASSERTION: the recovery executor NEVER re-invoked `a` (journal
    // replay), and DID re-run the dirty tail (`b`, `c`).
    expect(recoverSpy.invoked).not.toContain("a#0#0");
    expect(recoverSpy.invoked).toContain("b#0#0");
    expect(recoverSpy.invoked).toContain("c#0#0");

    // `a`'s attempts are UNCHANGED (it was not re-run).
    const aAfter = await nodeRunRow(runId, "a");
    expect(aAfter?.attempts).toBe(aAttemptsBefore);
    expect(aAfter?.status).toBe("done");
    // `b` is back to done after the re-drive.
    expect((await nodeRunRow(runId, "b"))?.status).toBe("done");
    // The run is terminal done again.
    const runRow = (await getDb().select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).limit(1))[0];
    expect(runRow.status).toBe("done");
  });

  it("(c) the run + reset node leave an audit trail (no silent loss)", async () => {
    const graph = fixtures.sequential;
    const tpl = await seedTemplate(graph);
    const runId = await seedRun(tpl);
    await new Scheduler({ cfg: makeCfg(runId, tpl, graph), db: getDb(), executor: new SpyExecutor() }).run();

    await getDb().update(schema.nodeRuns)
      .set({ status: "running", outputRef: null, completedAt: null })
      .where(eq(schema.nodeRuns.id, (await nodeRunRow(runId, "b"))!.id));
    await getDb().update(schema.workflowRuns).set({ status: "running", completedAt: null }).where(eq(schema.workflowRuns.id, runId));

    await recovery.reconcileOnStartup({ ownerEmail: OWNER, orgId: null, control: { executor: new SpyExecutor() } });

    const audits = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, "reconcile.startup"));
    // A run-level recovery row AND a node-level reset row both exist.
    expect(audits.some((a) => a.targetType === "workflow_run" && a.targetId === runId)).toBe(true);
    expect(audits.some((a) => a.targetType === "node_run")).toBe(true);
  });
});

// ── (b) stranded work item re-queued + re-claimed by exactly one worker ────────

describe("crash recovery (b): stranded claimed work_item re-queued, re-claimed once", () => {
  it("a claimed item is returned to queued by reconcile and re-claimed by exactly one worker (no double run)", async () => {
    const proj = newId("proj");
    const now = nowIso();
    await getDb().insert(schema.projects).values({
      id: proj, name: "P", key: "P", description: "", workingDir: "",
      gitRemote: null, defaultBranch: null, defaultWorkflowId: null,
      statusSchemes: null, environments: null, createdAt: now, updatedAt: now,
      ownerEmail: OWNER, orgId: null, visibility: "private",
    });
    const itemId = newId("wi");
    await getDb().insert(schema.workItems).values({
      id: itemId, projectId: proj, type: "task", title: "i", description: "",
      priority: 0, assignee: null, status: "待办", statusCategory: "todo",
      environment: null, severity: null, blocked: 0, blockedReason: null, blockedBy: null,
      resolution: null, statusStale: 0,
      // Stranded: claimed by a now-dead worker, with a stale claimed_at.
      execState: "claimed", claimedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      claimedBy: "dead-worker", workflowId: null, workflowRunId: "run_orphan",
      deliverable: null, createdAt: now, updatedAt: now,
      ownerEmail: OWNER, orgId: null, visibility: "private",
    });

    const result = await recovery.reconcileOnStartup({ ownerEmail: OWNER, orgId: null });

    // The item was returned to the queue.
    expect(result.requeuedWorkItems.map((w) => w.id)).toContain(itemId);
    const after = (await getDb().select().from(schema.workItems).where(eq(schema.workItems.id, itemId)).limit(1))[0];
    expect(after.execState).toBe("queued");
    expect(after.claimedBy).toBeNull();
    expect(after.workflowRunId).toBeNull();

    // EXACTLY ONE worker re-claims it (single-flight): two racing claims → one wins.
    const [c1, c2] = await Promise.all([
      claim.claimNextWorkItem("w-a"),
      claim.claimNextWorkItem("w-b"),
    ]);
    const winners = [c1, c2].filter((c) => c?.id === itemId);
    expect(winners.length).toBe(1);

    // (c) the requeue left an audit trail.
    const audits = await getDb().select().from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, itemId));
    expect(audits.some((a) => a.action === "reconcile.startup")).toBe(true);
  });
});

// ── (d) control + transition write audit rows ────────────────────────────────

describe("audit (d): a control action + a transition write audit rows (§7.4.7)", () => {
  async function seedProjectAndItem(opts: { status?: string; statusCategory?: string } = {}) {
    const proj = newId("proj");
    const now = nowIso();
    await getDb().insert(schema.projects).values({
      id: proj, name: "P", key: "P", description: "", workingDir: "",
      gitRemote: null, defaultBranch: null, defaultWorkflowId: null,
      statusSchemes: null, environments: null, createdAt: now, updatedAt: now,
      ownerEmail: OWNER, orgId: null, visibility: "private",
    });
    const itemId = newId("wi");
    await getDb().insert(schema.workItems).values({
      id: itemId, projectId: proj, type: "task", title: "i", description: "",
      priority: 0, assignee: null, status: opts.status ?? "待办",
      statusCategory: (opts.statusCategory as never) ?? "todo",
      environment: null, severity: null, blocked: 0, blockedReason: null, blockedBy: null,
      resolution: null, statusStale: 0, execState: "idle", claimedAt: null, claimedBy: null,
      workflowId: null, workflowRunId: null, deliverable: null, createdAt: now, updatedAt: now,
      ownerEmail: OWNER, orgId: null, visibility: "private",
    });
    return itemId;
  }

  it("transition-work-item (via the shared helper) writes a transition-work-item audit row", async () => {
    const itemId = await seedProjectAndItem({ status: "待办", statusCategory: "todo" });
    const item = (await getDb().select().from(schema.workItems).where(eq(schema.workItems.id, itemId)).limit(1))[0];

    await applyTransition({
      item: item as unknown as Record<string, unknown>,
      actor: "tester@local",
      input: { toStatus: "进行中" },
    });

    const audits = await getDb().select().from(schema.auditLog)
      .where(eq(schema.auditLog.action, "transition-work-item"));
    expect(audits.length).toBe(1);
    expect(audits[0].targetType).toBe("work_item");
    expect(audits[0].targetId).toBe(itemId);
    expect(audits[0].actor).toBe("tester@local");
    const detail = JSON.parse(audits[0].detail!);
    expect(detail.from).toBe("待办");
    expect(detail.to).toBe("进行中");
  });

  it("a control verb (run-cancel) writes a run.cancel audit row", async () => {
    const tpl = await seedTemplate();
    const runId = await seedRun(tpl);
    // Leave it pending so cancel has rows to skip.
    await cancelRun(runId);

    const audits = await getDb().select().from(schema.auditLog)
      .where(eq(schema.auditLog.action, "run.cancel"));
    expect(audits.length).toBe(1);
    expect(audits[0].targetType).toBe("workflow_run");
    expect(audits[0].targetId).toBe(runId);
  });
});

// ── (e) PR-merge webhook moves item to terminal + resolution:shipped ──────────

describe("terminal closure (e): PR-merge moves an item to its terminal stage / shipped", () => {
  it("applyTransition via the webhook path closes a 待发布 task to 已完成 / shipped", async () => {
    // A `task` scheme: 待办 → 进行中 → … → 待验收 → 已完成 (completed). Terminal shipped
    // stage = 已完成. Put the item near-terminal first (skip-forward is allowed).
    const proj = newId("proj");
    const now = nowIso();
    await getDb().insert(schema.projects).values({
      id: proj, name: "P", key: "P", description: "", workingDir: "",
      gitRemote: null, defaultBranch: null, defaultWorkflowId: null,
      statusSchemes: null, environments: null, createdAt: now, updatedAt: now,
      ownerEmail: OWNER, orgId: null, visibility: "private",
    });
    const itemId = newId("wi");
    await getDb().insert(schema.workItems).values({
      id: itemId, projectId: proj, type: "task", title: "ship me", description: "",
      priority: 0, assignee: null, status: "待验收", statusCategory: "in-progress",
      environment: null, severity: null, blocked: 0, blockedReason: null, blockedBy: null,
      resolution: null, statusStale: 0, execState: "idle", claimedAt: null, claimedBy: null,
      workflowId: null, workflowRunId: null, deliverable: null, createdAt: now, updatedAt: now,
      ownerEmail: OWNER, orgId: null, visibility: "private",
    });
    const item = (await getDb().select().from(schema.workItems).where(eq(schema.workItems.id, itemId)).limit(1))[0];

    const { terminalShippedStage } = await import("../../../shared/status-schemes.js");
    const { schemeForType } = await import("../../work-items/schemes.js");
    const toStatus = terminalShippedStage(schemeForType(null, "task"))!;
    expect(toStatus).toBe("已完成");

    const outcome = await applyTransition({
      item: item as unknown as Record<string, unknown>,
      actor: "webhook:pr-merge",
      auditAction: "webhook.pr-merge",
      auditDetail: { source: "github-pr-merge", eventId: "PR-42" },
      input: { toStatus, resolution: "shipped", environment: "prod" },
    });

    expect(outcome.to).toBe("已完成");
    expect(outcome.statusCategory).toBe("completed");
    expect(outcome.resolution).toBe("shipped");

    const after = (await getDb().select().from(schema.workItems).where(eq(schema.workItems.id, itemId)).limit(1))[0];
    expect(after.status).toBe("已完成");
    expect(after.statusCategory).toBe("completed");
    expect(after.resolution).toBe("shipped");

    // The webhook closure left a status-log trail AND a webhook.pr-merge audit row.
    const log = await getDb().select().from(schema.workItemStatusLog).where(eq(schema.workItemStatusLog.workItemId, itemId));
    expect(log.some((l) => l.toStatus === "已完成")).toBe(true);
    const audits = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, "webhook.pr-merge"));
    expect(audits.length).toBe(1);
    expect(JSON.parse(audits[0].detail!).eventId).toBe("PR-42");
  });
});
