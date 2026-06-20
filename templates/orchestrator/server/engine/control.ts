// Run-control entrypoints (DESIGN §4.3) built on the deterministic scheduler.
// Each control verb persists its INTENT into the journal (node_runs /
// workflow_runs rows), then RE-DRIVES the run with the two-pass resume
// (scheduler.resume, DESIGN §1.7): a done-and-clean NodeRun replays from its
// journaled output artifact at ZERO executor invocations; only the dirty tail
// re-runs live. This is what makes pause→resume, retry-node, override and the
// human gate idempotent and replayable — they all funnel through one mechanism.

import { eq } from "drizzle-orm";
import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { getDb, schema } from "../db/index.js";
import { nowIso } from "../../actions/_util.js";
import { parseGraph, type WorkflowGraph } from "../../shared/types.js";
import { EchoExecutor } from "./echo-executor.js";
import {
  Scheduler,
  humanGateOutput,
  type HumanDecision,
  type RunOutcome,
  type SubworkflowResolver,
} from "./scheduler.js";
import {
  DEFAULT_CAPS,
  type NodeConfigPatch,
  type NodeExecutor,
  type RunConfig,
} from "./types.js";
import { outputArtifactId } from "./ids.js";
import { putArtifact } from "./store.js";

/** Options shared by the re-drive helpers (test executor injection, caps). */
export interface ControlOptions {
  executor?: NodeExecutor;
  echoDelayMs?: number;
  caps?: Partial<RunConfig["caps"]>;
}

interface LoadedRun {
  runRow: typeof schema.workflowRuns.$inferSelect;
  graph: WorkflowGraph;
  cfg: RunConfig;
}

/**
 * Load a run row + its template graph and assemble a RunConfig. `nodeOverrides`
 * are read from any persisted run-scoped overrides (stored on workflow_runs as
 * a JSON column is not available in P1; overrides are passed in by the caller).
 */
async function loadRun(
  runId: string,
  opts: ControlOptions & {
    nodeOverrides?: Record<string, NodeConfigPatch>;
  } = {},
): Promise<LoadedRun> {
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
  const cfg: RunConfig = {
    runId,
    templateId: runRow.templateId,
    graph,
    userEmail: runRow.ownerEmail,
    orgId: runRow.orgId ?? null,
    tokenBudget: runRow.tokenBudget ?? null,
    seed: 1,
    caps: { ...DEFAULT_CAPS, ...(opts.caps ?? {}) },
    echoDelayMs: opts.echoDelayMs ?? 0,
    nodeOverrides: opts.nodeOverrides,
  };
  return { runRow, graph, cfg };
}

/**
 * Build a subworkflow resolver from an eagerly-loaded id/name → graph map so the
 * scheduler can resolve refs synchronously during expansion.
 */
async function buildResolverMap(
  ownerEmail: string,
): Promise<SubworkflowResolver> {
  const db = getDb();
  const rows = await db
    .select({
      id: schema.workflowTemplates.id,
      name: schema.workflowTemplates.name,
      graph: schema.workflowTemplates.graph,
    })
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.ownerEmail, ownerEmail));
  const byId = new Map<string, WorkflowGraph>();
  const byName = new Map<string, WorkflowGraph>();
  for (const r of rows) {
    const g = parseGraph(r.graph);
    byId.set(r.id, g);
    byName.set(r.name, g);
  }
  return (ref: string) => byId.get(ref) ?? byName.get(ref) ?? null;
}

/** Persist a run's terminal/intermediate status + token totals. */
async function persistRunStatus(
  runId: string,
  outcome: RunOutcome,
): Promise<void> {
  const db = getDb();
  const completed =
    outcome.status === "done" ||
    outcome.status === "failed" ||
    outcome.status === "cancelled";
  await db
    .update(schema.workflowRuns)
    .set({
      status: outcome.status,
      tokensSpent: outcome.tokensSpent,
      completedAt: completed ? nowIso() : null,
    })
    .where(eq(schema.workflowRuns.id, runId));
}

/** Run a freshly-built scheduler's resume() inside the run's request context. */
async function driveResume(
  load: LoadedRun,
  opts: ControlOptions,
): Promise<RunOutcome> {
  const executor = opts.executor ?? new EchoExecutor(opts.echoDelayMs ?? 0);
  const resolveTemplate = await buildResolverMap(load.runRow.ownerEmail);
  return runWithRequestContext(
    { userEmail: load.cfg.userEmail, orgId: load.cfg.orgId ?? undefined },
    async () => {
      const scheduler = new Scheduler({
        cfg: load.cfg,
        db: getDb(),
        executor,
        resolveTemplate,
      });
      return scheduler.resume();
    },
  );
}

// ── pause ────────────────────────────────────────────────────────────────────

/**
 * run-pause: stop scheduling NEW nodes; let running settle. In the headless
 * (synchronous) model a `wait=true` run has already quiesced, so pause persists
 * the intent — `workflow_runs.status='paused'` — which run-resume picks up. A
 * still-`running` run is flipped to paused so no further scheduling happens.
 */
export async function pauseRun(runId: string): Promise<{ status: string }> {
  const db = getDb();
  const rows = await db
    .select({ status: schema.workflowRuns.status })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, runId))
    .limit(1);
  if (rows.length === 0) throw new Error(`workflow_run ${runId} not found`);
  const cur = rows[0].status;
  if (cur === "done" || cur === "failed" || cur === "cancelled") {
    // Terminal — nothing to pause.
    return { status: cur };
  }
  await db
    .update(schema.workflowRuns)
    .set({ status: "paused" })
    .where(eq(schema.workflowRuns.id, runId));
  return { status: "paused" };
}

// ── resume ─────────────────────────────────────────────────────────────────

/**
 * run-resume: the §1.7 two-pass resume. Re-drives the run from its journal —
 * done-and-clean NodeRuns replay (0 invokes), the dirty tail re-runs live.
 */
export async function resumeRun(
  runId: string,
  opts: ControlOptions = {},
): Promise<RunOutcome> {
  const load = await loadRun(runId);
  await getDb()
    .update(schema.workflowRuns)
    .set({ status: "running" })
    .where(eq(schema.workflowRuns.id, runId));
  const outcome = await driveResume(load, opts);
  await persistRunStatus(runId, outcome);
  return outcome;
}

// ── cancel ─────────────────────────────────────────────────────────────────

/**
 * run-cancel: cooperative abort (DESIGN §4.3). No new nodes scheduled, any
 * pending/ready/awaiting NodeRun → skipped, run.status = cancelled. (Running
 * leaves in a live async driver settle at their next boundary; in the headless
 * model there are none in flight.)
 */
export async function cancelRun(
  runId: string,
): Promise<{ status: string; skipped: number }> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.id, runId))
    .limit(1);
  if (rows.length === 0) throw new Error(`workflow_run ${runId} not found`);

  const nodeRuns = await db
    .select()
    .from(schema.nodeRuns)
    .where(eq(schema.nodeRuns.runId, runId));
  const now = nowIso();
  let skipped = 0;
  for (const nr of nodeRuns) {
    if (
      nr.status === "pending" ||
      nr.status === "ready" ||
      nr.status === "running" ||
      nr.status === "awaiting-approval"
    ) {
      await db
        .update(schema.nodeRuns)
        .set({ status: "skipped", completedAt: now, lastHeartbeat: null })
        .where(eq(schema.nodeRuns.id, nr.id));
      skipped += 1;
    }
  }
  await db
    .update(schema.workflowRuns)
    .set({ status: "cancelled", completedAt: now })
    .where(eq(schema.workflowRuns.id, runId));
  return { status: "cancelled", skipped };
}

// ── retry-node ───────────────────────────────────────────────────────────────

/**
 * run-retry-node: reset a failed node to re-run live; its downstream divergent
 * tail re-runs and the upstream is reused from journal (0 upstream invokes).
 * Mechanism: flip the target node_run to `pending` (so resume's Pass-1 dirty set
 * includes it + its transitive downstream), then re-drive via resume.
 */
export async function retryNode(
  runId: string,
  nodeRunId: string,
  opts: ControlOptions = {},
): Promise<RunOutcome> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.nodeRuns)
    .where(eq(schema.nodeRuns.id, nodeRunId))
    .limit(1);
  const nr = rows[0];
  if (!nr || nr.runId !== runId) {
    throw new Error(`NodeRun ${nodeRunId} not found in run ${runId}`);
  }
  await db
    .update(schema.nodeRuns)
    .set({
      status: "pending",
      error: null,
      outputRef: null,
      completedAt: null,
      lastHeartbeat: null,
    })
    .where(eq(schema.nodeRuns.id, nodeRunId));
  return resumeRun(runId, opts);
}

// ── node-override ────────────────────────────────────────────────────────────

/**
 * node-override: apply a prompt/model/engine/effort patch to a node and re-run
 * it + its downstream; upstream reused. The patch is scoped to THIS run via
 * RunConfig.nodeOverrides (never mutates the shared template, immutability §). The
 * target node_run is reset to pending so resume re-runs it live.
 */
export async function overrideNode(
  runId: string,
  nodeRunId: string,
  patch: NodeConfigPatch,
  opts: ControlOptions = {},
): Promise<RunOutcome> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.nodeRuns)
    .where(eq(schema.nodeRuns.id, nodeRunId))
    .limit(1);
  const nr = rows[0];
  if (!nr || nr.runId !== runId) {
    throw new Error(`NodeRun ${nodeRunId} not found in run ${runId}`);
  }
  // Persist the patched routing onto the node_run row for observability.
  await db
    .update(schema.nodeRuns)
    .set({
      status: "pending",
      error: null,
      outputRef: null,
      completedAt: null,
      lastHeartbeat: null,
      ...(patch.engine ? { engine: patch.engine } : {}),
      ...(patch.model ? { model: patch.model } : {}),
    })
    .where(eq(schema.nodeRuns.id, nodeRunId));

  const load = await loadRun(runId, {
    ...opts,
    nodeOverrides: { [nr.nodeId]: patch },
  });
  await db
    .update(schema.workflowRuns)
    .set({ status: "running" })
    .where(eq(schema.workflowRuns.id, runId));
  const outcome = await driveResume(load, opts);
  await persistRunStatus(runId, outcome);
  return outcome;
}

// ── resolve-human-gate ───────────────────────────────────────────────────────

/**
 * resolve-human-gate (DESIGN §3.1/§11): resolve a node parked at
 * awaiting-approval. approve → the node is marked done and downstream releases;
 * reject → the node is done with a reject marker and its OUT-EDGE branch
 * downstream is set to skipped (the scheduler treats a rejected gate as a dead
 * path). The human node state lives in node_runs, NOT the chat transcript.
 *
 * Implemented as an equivalent in-engine gate rather than the dispatch approval
 * primitive: `createApprovalRequest`/`approveRequest`
 * (packages/dispatch/src/server/lib/dispatch-store.ts) are NOT exported from any
 * public `@agent-native/dispatch` entrypoint (only `./server`, `./actions`,
 * `./db`, `./components` are; dispatch-store lives under `server/lib/` and is
 * not re-exported), and dispatch carries its own DB schema + config singleton.
 * The design also mandates the gate state live in node_runs (§11), which this
 * does directly.
 */
export async function resolveHumanGate(
  runId: string,
  nodeRunId: string,
  decision: HumanDecision,
  input: unknown,
  opts: ControlOptions = {},
): Promise<RunOutcome> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.nodeRuns)
    .where(eq(schema.nodeRuns.id, nodeRunId))
    .limit(1);
  const nr = rows[0];
  if (!nr || nr.runId !== runId) {
    throw new Error(`NodeRun ${nodeRunId} not found in run ${runId}`);
  }
  if (nr.type !== "human") {
    throw new Error(
      `NodeRun ${nodeRunId} is not a human gate (type=${nr.type})`,
    );
  }
  if (nr.status !== "awaiting-approval") {
    throw new Error(
      `Human gate ${nodeRunId} is not awaiting approval (status=${nr.status})`,
    );
  }

  // Journal the decision as the gate's output artifact, keyed by its journal key
  // so resume replays it (and the scheduler reads the reject marker downstream).
  const key = {
    nodeId: nr.nodeId,
    iteration: nr.iteration,
    fanoutIndex: nr.fanoutIndex,
  };
  const outId = outputArtifactId(runId, key);
  await putArtifact(db, {
    id: outId,
    runId,
    nodeRunId: nr.id,
    kind: "node-output",
    value: humanGateOutput(decision, input),
  });
  await db
    .update(schema.nodeRuns)
    .set({ status: "done", outputRef: outId, completedAt: nowIso() })
    .where(eq(schema.nodeRuns.id, nr.id));

  // Re-drive: approve releases downstream; reject's dead-path skip cascades.
  return resumeRun(runId, opts);
}

/** Re-exported so the initial executeRun can build the same resolver. */
export { buildResolverMap };
