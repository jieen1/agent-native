// Headless P6 verification (DESIGN §14 / §6.2b / §7.4.7). Runs the REAL framework
// migrations against data/app.db, then exercises the P6 acceptance flows and
// prints DB evidence. NOT a unit test — a one-shot proof against a real @libsql
// DB so the migration (v18 audit_log) and the audit/recovery/webhook paths are
// shown to work end-to-end on a fresh schema, not just in the temp-DB suite.
//
//   pnpm --filter orchestrator exec tsx server/recovery/p6-verify-cli.ts
//
// Uses an isolated temp DB by default so it never mutates data/app.db; pass
// --real to run against the configured DATABASE_URL (data/app.db).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const useReal = process.argv.includes("--real");
if (!useReal) {
  const dir = mkdtempSync(join(tmpdir(), "orch-p6-verify-"));
  const file = join(dir, "verify.db").replace(/\\/g, "/");
  process.env.DATABASE_URL = `file:${file}`;
}
process.env.AGENT_USER_EMAIL = process.env.AGENT_USER_EMAIL ?? "local@localhost";

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

async function main(): Promise<void> {
  const ok: string[] = [];
  const fail: string[] = [];
  const assert = (cond: boolean, label: string) => {
    (cond ? ok : fail).push(label);
    log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  };

  // ── 1. Run the REAL migrations (proves v18 audit_log applies on a fresh DB) ──
  const { runMigrations } = await import("@agent-native/core/db");
  // Re-import the template's migration list by invoking the plugin default.
  const dbPlugin = (await import("../plugins/db.js")).default;
  await dbPlugin({} as never);
  void runMigrations; // (referenced for clarity; the plugin ran them)

  const { getDb, getDbExec, schema } = await import("../db/index.js");
  const { eq } = await import("drizzle-orm");
  const { nowIso, newId } = await import("../../actions/_util.js");

  // Evidence: the audit_log table + the migrations row for v18.
  const tbl = await getDbExec().execute(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'`,
  );
  assert(tbl.rows.length === 1, "v18 migration created audit_log table (fresh DB)");
  const mig = await getDbExec().execute(
    `SELECT MAX(version) AS v FROM orchestrator_migrations`,
  );
  const maxV = Number(mig.rows[0]?.v ?? 0);
  log(`  evidence: max migration version = ${maxV}`);
  assert(maxV >= 18, "max migration version >= 18");

  const OWNER = "local@localhost";
  const recovery = await import("./reconcile.js");
  const { applyTransition } = await import("../work-items/transition.js");
  const { cancelRun } = await import("../engine/control.js");
  const { Scheduler } = await import("../engine/scheduler.js");
  const { DEFAULT_CAPS } = await import("../engine/types.js");
  const fixtures = await import("../engine/fixtures.js");
  const claim = await import("../queue/claim.js");
  const {
    VMCapacityExhaustedError,
    TokenBudgetExceededError,
    isVMCapacityExhausted,
    isTokenBudgetExceeded,
  } = await import("../runtime/backpressure.js");

  // ── 2. (b) distinct error types ──────────────────────────────────────────
  const vmErr = new VMCapacityExhaustedError(4, 4);
  const budgetErr = new TokenBudgetExceededError(100, 100);
  assert(
    isVMCapacityExhausted(vmErr) && !isTokenBudgetExceeded(vmErr),
    "VMCapacityExhausted is NOT a TokenBudgetExceeded (no mislabel)",
  );
  assert(
    isTokenBudgetExceeded(budgetErr) && !isVMCapacityExhausted(budgetErr),
    "TokenBudgetExceeded is NOT a VMCapacityExhausted",
  );

  // ── seed a project + template ───────────────────────────────────────────
  const now = nowIso();
  const tplId = newId("tpl");
  await getDb().insert(schema.workflowTemplates).values({
    id: tplId, name: "verify", description: "",
    graph: JSON.stringify(fixtures.sequential), version: 1,
    createdAt: now, updatedAt: now, ownerEmail: OWNER, orgId: null, visibility: "private",
  });
  const projId = newId("proj");
  await getDb().insert(schema.projects).values({
    id: projId, name: "P", key: "P", description: "", workingDir: "",
    gitRemote: null, defaultBranch: null, defaultWorkflowId: null,
    statusSchemes: null, environments: null, createdAt: now, updatedAt: now,
    ownerEmail: OWNER, orgId: null, visibility: "private",
  });

  // ── 3. (a) crash recovery: done preserved, stranded running re-driven ──────
  const runId = newId("run");
  await getDb().insert(schema.workflowRuns).values({
    id: runId, templateId: tplId, workItemId: null, status: "pending",
    deliverable: null, tokenBudget: null, tokensSpent: 0, dynamicAuthored: 0,
    startedAt: now, completedAt: null, ownerEmail: OWNER, orgId: null, visibility: "private",
  });
  const cfg = {
    runId, templateId: tplId, graph: fixtures.sequential, userEmail: OWNER,
    orgId: null, tokenBudget: null, seed: 1, caps: { ...DEFAULT_CAPS }, echoDelayMs: 0,
  };
  const invokedFirst: string[] = [];
  const spy1 = {
    kind: "spy",
    async invoke(input: { node: { id: string }; iteration: number; fanoutIndex: number; deps: unknown }) {
      invokedFirst.push(`${input.node.id}#${input.iteration}#${input.fanoutIndex}`);
      return { output: { node: input.node.id }, tokensSpent: 0 };
    },
  };
  await new Scheduler({ cfg, db: getDb(), executor: spy1 as never }).run();

  const nodeRows = await getDb().select().from(schema.nodeRuns).where(eq(schema.nodeRuns.runId, runId));
  const aRow = nodeRows.find((r) => r.nodeId === "a")!;
  const aAttemptsBefore = aRow.attempts;
  // Crash: b → running, c/end → pending, run → running.
  await getDb().update(schema.nodeRuns).set({ status: "running", outputRef: null, completedAt: null })
    .where(eq(schema.nodeRuns.id, nodeRows.find((r) => r.nodeId === "b")!.id));
  for (const nid of ["c", "end"]) {
    await getDb().update(schema.nodeRuns).set({ status: "pending", outputRef: null, completedAt: null })
      .where(eq(schema.nodeRuns.id, nodeRows.find((r) => r.nodeId === nid)!.id));
  }
  await getDb().update(schema.workflowRuns).set({ status: "running", completedAt: null })
    .where(eq(schema.workflowRuns.id, runId));

  const invokedRecover: string[] = [];
  const spy2 = {
    kind: "spy",
    async invoke(input: { node: { id: string }; iteration: number; fanoutIndex: number; deps: unknown }) {
      invokedRecover.push(`${input.node.id}#${input.iteration}#${input.fanoutIndex}`);
      return { output: { node: input.node.id }, tokensSpent: 0 };
    },
  };
  const recResult = await recovery.reconcileOnStartup({ ownerEmail: OWNER, orgId: null, control: { executor: spy2 as never } });
  const aAfter = (await getDb().select().from(schema.nodeRuns).where(eq(schema.nodeRuns.id, aRow.id)).limit(1))[0];

  log(`  evidence: recovery re-invoked = [${invokedRecover.join(", ")}]`);
  assert(recResult.recoveredRuns.length === 1, "(a) one running run recovered");
  assert(!invokedRecover.includes("a#0#0"), "(a) done node 'a' NOT re-run (journal replay)");
  assert(invokedRecover.includes("b#0#0"), "(a) stranded running node 'b' re-driven");
  assert(aAfter.attempts === aAttemptsBefore, "(a) 'a' attempts unchanged (not re-run)");
  assert(recResult.recoveredRuns[0].status === "done", "(a) run re-driven to done");

  // ── 4. (c) trail rows for the recovery ─────────────────────────────────────
  const recAudits = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, "reconcile.startup"));
  assert(
    recAudits.some((a) => a.targetType === "workflow_run") && recAudits.some((a) => a.targetType === "node_run"),
    "(c) reconcile left an audit trail (run + node rows)",
  );

  // ── 5. (b) stranded work item re-queued + re-claimed exactly once ──────────
  const itemId = newId("wi");
  await getDb().insert(schema.workItems).values({
    id: itemId, projectId: projId, type: "task", title: "i", description: "",
    priority: 0, assignee: null, status: "待办", statusCategory: "todo",
    environment: null, severity: null, blocked: 0, blockedReason: null, blockedBy: null,
    resolution: null, statusStale: 0, execState: "claimed",
    claimedAt: new Date(Date.now() - 10 * 60_000).toISOString(), claimedBy: "dead",
    workflowId: null, workflowRunId: "orphan", deliverable: null, createdAt: now, updatedAt: now,
    ownerEmail: OWNER, orgId: null, visibility: "private",
  });
  const rec2 = await recovery.reconcileOnStartup({ ownerEmail: OWNER, orgId: null });
  const itemAfter = (await getDb().select().from(schema.workItems).where(eq(schema.workItems.id, itemId)).limit(1))[0];
  assert(rec2.requeuedWorkItems.some((w) => w.id === itemId), "(b) stranded claimed item re-queued");
  assert(itemAfter.execState === "queued" && itemAfter.claimedBy === null, "(b) item back to queued, claim cleared");
  const claims = await Promise.all([claim.claimNextWorkItem("wa"), claim.claimNextWorkItem("wb")]);
  const winners = claims.filter((c) => c?.id === itemId);
  assert(winners.length === 1, "(b) re-claimed by EXACTLY ONE worker (single-flight)");

  // ── 6. (d) control + transition write audit rows ───────────────────────────
  const cancelRunId = newId("run");
  await getDb().insert(schema.workflowRuns).values({
    id: cancelRunId, templateId: tplId, workItemId: null, status: "pending",
    deliverable: null, tokenBudget: null, tokensSpent: 0, dynamicAuthored: 0,
    startedAt: now, completedAt: null, ownerEmail: OWNER, orgId: null, visibility: "private",
  });
  await cancelRun(cancelRunId);
  const cancelAudits = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, "run.cancel"));
  assert(cancelAudits.some((a) => a.targetId === cancelRunId), "(d) run.cancel wrote an audit row");

  const transItemId = newId("wi");
  await getDb().insert(schema.workItems).values({
    id: transItemId, projectId: projId, type: "task", title: "t", description: "",
    priority: 0, assignee: null, status: "待办", statusCategory: "todo",
    environment: null, severity: null, blocked: 0, blockedReason: null, blockedBy: null,
    resolution: null, statusStale: 0, execState: "idle", claimedAt: null, claimedBy: null,
    workflowId: null, workflowRunId: null, deliverable: null, createdAt: now, updatedAt: now,
    ownerEmail: OWNER, orgId: null, visibility: "private",
  });
  const transItem = (await getDb().select().from(schema.workItems).where(eq(schema.workItems.id, transItemId)).limit(1))[0];
  await applyTransition({ item: transItem as never, actor: "verify@local", input: { toStatus: "进行中" } });
  const transAudits = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, "transition-work-item"));
  assert(transAudits.some((a) => a.targetId === transItemId), "(d) transition-work-item wrote an audit row");

  // ── 7. (e) PR-merge terminal closure → 已完成 / shipped ─────────────────────
  const shipItemId = newId("wi");
  await getDb().insert(schema.workItems).values({
    id: shipItemId, projectId: projId, type: "task", title: "ship", description: "",
    priority: 0, assignee: null, status: "待验收", statusCategory: "in-progress",
    environment: null, severity: null, blocked: 0, blockedReason: null, blockedBy: null,
    resolution: null, statusStale: 0, execState: "idle", claimedAt: null, claimedBy: null,
    workflowId: null, workflowRunId: null, deliverable: null, createdAt: now, updatedAt: now,
    ownerEmail: OWNER, orgId: null, visibility: "private",
  });
  const shipItem = (await getDb().select().from(schema.workItems).where(eq(schema.workItems.id, shipItemId)).limit(1))[0];
  const { terminalShippedStage } = await import("../../shared/status-schemes.js");
  const { schemeForType } = await import("../work-items/schemes.js");
  const toStatus = terminalShippedStage(schemeForType(null, "task"))!;
  const closeOutcome = await applyTransition({
    item: shipItem as never, actor: "webhook:pr-merge", auditAction: "webhook.pr-merge",
    auditDetail: { source: "github-pr-merge", eventId: "PR-7" },
    input: { toStatus, resolution: "shipped", environment: "prod" },
  });
  const shipAfter = (await getDb().select().from(schema.workItems).where(eq(schema.workItems.id, shipItemId)).limit(1))[0];
  log(`  evidence: closed → status=${shipAfter.status} category=${shipAfter.statusCategory} resolution=${shipAfter.resolution}`);
  assert(closeOutcome.to === "已完成" && closeOutcome.resolution === "shipped", "(e) PR-merge moved item to 已完成 / shipped");
  assert(shipAfter.statusCategory === "completed", "(e) item is in the completed category");
  const webhookAudits = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, "webhook.pr-merge"));
  assert(webhookAudits.some((a) => a.targetId === shipItemId), "(e) webhook closure wrote a webhook.pr-merge audit row");

  // ── summary ────────────────────────────────────────────────────────────────
  log("");
  log(`P6 VERIFY: ${ok.length} passed, ${fail.length} failed`);
  if (fail.length > 0) {
    log(`FAILED: ${fail.join(" | ")}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("p6-verify crashed:", err);
  process.exit(1);
});
