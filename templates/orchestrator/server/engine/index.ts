// Engine entry point. `executeRun` instantiates a Scheduler for a workflow_runs
// row and drives it to completion headlessly (DESIGN §4.2 — modeled on
// jobs/scheduler.ts: runWithRequestContext wrapping the detached work). P1 uses
// the deterministic ECHO executor; P2 swaps in real microVM executors at the
// same NodeExecutor seam.

import { eq } from "drizzle-orm";
import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { getDb, schema } from "../db/index.js";
import { nowIso } from "../../actions/_util.js";
import { parseGraph } from "../../shared/types.js";
import { EchoExecutor } from "./echo-executor.js";
import { Scheduler, type RunOutcome } from "./scheduler.js";
import { DEFAULT_CAPS, type NodeExecutor, type RunConfig } from "./types.js";

/** A fixed default seed so a run with no explicit seed is still deterministic. */
export const DEFAULT_SEED = 1;

export interface ExecuteRunOptions {
  /** Override the executor (tests inject a spy; P2 injects real executors). */
  executor?: NodeExecutor;
  /** Observable echo delay (ms); 0 for fastest, >0 to see concurrency overlap. */
  echoDelayMs?: number;
  /** Concurrency caps override (tests pin maxConcurrentModelCalls). */
  caps?: Partial<RunConfig["caps"]>;
}

/**
 * Load a workflow_runs row + its template graph, run the deterministic
 * scheduler to completion inside the run's request context, and persist the
 * final run status + token totals. Returns the outcome for the caller (and the
 * CLI/test) to assert against.
 */
export async function executeRun(
  runId: string,
  opts: ExecuteRunOptions = {},
): Promise<RunOutcome> {
  const db = getDb();
  const runRows = await db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, runId))
    .limit(1);
  const runRow = runRows[0];
  if (!runRow) throw new Error(`workflow_run ${runId} not found`);

  const tplRows = await db
    .select()
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, runRow.templateId))
    .limit(1);
  const tpl = tplRows[0];
  if (!tpl) throw new Error(`template ${runRow.templateId} not found`);

  const graph = parseGraph(tpl.graph);
  const executor =
    opts.executor ?? new EchoExecutor(opts.echoDelayMs ?? 0);

  const cfg: RunConfig = {
    runId,
    templateId: runRow.templateId,
    graph,
    userEmail: runRow.ownerEmail,
    orgId: runRow.orgId ?? null,
    tokenBudget: runRow.tokenBudget ?? null,
    seed: DEFAULT_SEED,
    caps: { ...DEFAULT_CAPS, ...(opts.caps ?? {}) },
    echoDelayMs: opts.echoDelayMs ?? 0,
  };

  // Mark running.
  await db
    .update(schema.workflowRuns)
    .set({ status: "running", startedAt: nowIso() })
    .where(eq(schema.workflowRuns.id, runId));

  // Re-establish request context inside the detached work (DESIGN §4.2
  // landmine 2) so ownable scoping / secret resolution work for real executors.
  const outcome = await runWithRequestContext(
    { userEmail: cfg.userEmail, orgId: cfg.orgId ?? undefined },
    async () => {
      const scheduler = new Scheduler({ cfg, db, executor });
      return scheduler.run();
    },
  );

  // Persist terminal status + totals.
  await db
    .update(schema.workflowRuns)
    .set({
      status: outcome.status,
      tokensSpent: outcome.tokensSpent,
      completedAt: nowIso(),
    })
    .where(eq(schema.workflowRuns.id, runId));

  return outcome;
}

export { Scheduler } from "./scheduler.js";
export { EchoExecutor } from "./echo-executor.js";
export * from "./types.js";
