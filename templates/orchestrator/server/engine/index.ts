// Engine entry point. `executeRun` instantiates a Scheduler for a workflow_runs
// row and drives it to completion headlessly (DESIGN §4.2 — modeled on
// jobs/scheduler.ts: runWithRequestContext wrapping the detached work). P1 uses
// the deterministic ECHO executor; P2 swaps in real microVM executors at the
// same NodeExecutor seam.

import { eq } from "drizzle-orm";
import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { getDb, schema } from "../db/index.js";
import { nowIso, newId } from "../../actions/_util.js";
import {
  parseGraph,
  type Node,
  type NodeRuntimeSpec,
} from "../../shared/types.js";
import { EchoExecutor } from "./echo-executor.js";
import { Scheduler, type RunOutcome } from "./scheduler.js";
import { DEFAULT_CAPS, type NodeExecutor, type RunConfig } from "./types.js";
import { buildResolverMap } from "./control.js";
import { reconcileOnTerminal } from "../work-items/watchdog.js";
import { checkFinalizeStatus } from "../work-items/finalize-gate.js";
import { isFinalizeStatusNode } from "../../shared/finalize-gate.js";
import type { NodeGate } from "./scheduler.js";

/** A fixed default seed so a run with no explicit seed is still deterministic. */
export const DEFAULT_SEED = 1;

export interface ExecuteRunOptions {
  /** Override the executor (tests inject a spy; P2 injects real executors). */
  executor?: NodeExecutor;
  /** Observable echo delay (ms); 0 for fastest, >0 to see concurrency overlap. */
  echoDelayMs?: number;
  /** Concurrency caps override (tests pin maxConcurrentModelCalls). */
  caps?: Partial<RunConfig["caps"]>;
  /**
   * Final fallback executor choice when a microvm node resolves no engine
   * (DESIGN §0.6 SYSTEM_DEFAULT). Passed through to the routing executor.
   */
  systemDefault?: string | null;
}

/** Per-run git context derived from the run's bound project (DESIGN §7.1a). */
interface RunGitContext {
  gitRemote: string;
  baseRef: string;
  branch: string;
}

/**
 * Resolve the git context for a run from its bound work item's project. Returns
 * null when the run has no work item, no project, or the project links no repo
 * (`gitRemote` unset) — those runs execute with no clone/delivery.
 */
async function resolveRunGitContext(
  db: ReturnType<typeof getDb>,
  workItemId: string | null,
  runId: string,
): Promise<RunGitContext | null> {
  if (!workItemId) return null;
  const itemRows = await db
    .select({ projectId: schema.workItems.projectId })
    .from(schema.workItems)
    .where(eq(schema.workItems.id, workItemId))
    .limit(1);
  const projectId = itemRows[0]?.projectId;
  if (!projectId) return null;
  const projRows = await db
    .select({
      gitRemote: schema.projects.gitRemote,
      defaultBranch: schema.projects.defaultBranch,
    })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .limit(1);
  const proj = projRows[0];
  if (!proj?.gitRemote || proj.gitRemote.trim() === "") return null;
  const safeRunId = runId.replace(/[^A-Za-z0-9._-]/g, "-");
  return {
    gitRemote: proj.gitRemote.trim(),
    baseRef: (proj.defaultBranch && proj.defaultBranch.trim()) || "main",
    branch: `an/run-${safeRunId}`,
  };
}

/**
 * Thread the run git context into ONE node's runtime spec (DESIGN §7.1a). Only
 * nodes that EXECUTE in a microVM get it — the leaf `agent`/`tool` types whose
 * runtime is not explicitly `none`. Control/container nodes (start, end, join,
 * parallel, fanout, branch) never provision a VM, so they are returned
 * untouched. An explicit template value always wins (`??`), so a node can pin a
 * different repo/ref/branch than the project default.
 */
function injectGitContext(node: Node, git: RunGitContext): Node {
  const runsInVm =
    (node.type === "agent" || node.type === "tool") &&
    node.runtime?.kind !== "none";
  if (!runsInVm) return node;
  const base: NodeRuntimeSpec = node.runtime ?? {
    kind: "microvm",
    onFailure: "recreate",
  };
  return {
    ...node,
    runtime: {
      ...base,
      gitRemote: base.gitRemote ?? git.gitRemote,
      baseRef: base.baseRef ?? git.baseRef,
      branch: base.branch ?? git.branch,
    },
  };
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

  // P3 GIT DELIVERY (DESIGN §7.1a): when this run is bound to a work item whose
  // project links a code repo, thread the project's gitRemote + defaultBranch and
  // the per-run branch (`an/run-<runId>`) into EVERY microvm node's runtime spec.
  // INIT then clones the real repo into the VM and EXTRACT delivers (commit +
  // push branch + open PR). A run with no project repo is untouched.
  const gitContext = await resolveRunGitContext(db, runRow.workItemId, runId);
  // eslint-disable-next-line no-console
  console.log(
    `[git-context] runId=${runId} workItemId=${runRow.workItemId} ctx=${JSON.stringify(gitContext)}`,
  );
  const effectiveGraph = gitContext
    ? { ...graph, nodes: graph.nodes.map((n) => injectGitContext(n, gitContext)) }
    : graph;

  // P2b: by default, route each node to its real executor + the 7-stage
  // NodeRunner for microvm nodes, falling back to the deterministic echo
  // executor for non-microVM (pure-reasoning / fixture) nodes. Tests inject an
  // explicit `executor` (the echo spy) to keep the non-microVM suites
  // deterministic and VM-free.
  let executor: NodeExecutor;
  if (opts.executor) {
    executor = opts.executor;
  } else {
    // Lazily pull in the routing executor (and its microVM/runtime chain) ONLY
    // when no executor is injected. This keeps modules that drive the scheduler
    // with an explicit executor (the headless queue path under test) free of the
    // heavy runtime import graph.
    const { RoutingNodeExecutor, loadRuntimeConfigRows } =
      await import("../runtime/routing-node-executor.js");
    const routingCtx = await loadRuntimeConfigRows({
      systemDefault: opts.systemDefault ?? null,
    });
    executor = new RoutingNodeExecutor({
      fallback: new EchoExecutor(opts.echoDelayMs ?? 0),
      ctx: routingCtx,
    });
  }

  const cfg: RunConfig = {
    runId,
    templateId: runRow.templateId,
    graph: effectiveGraph,
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

  // Resolve subworkflow refs (DESIGN §1.2/§3.1) so the first run can inline-
  // expand a subworkflow node, not just resume.
  const resolveTemplate = await buildResolverMap(cfg.userEmail);

  // finalize-status GATE (DESIGN §6.2b L1): when the scheduler reaches the
  // finalize-status library node, assert the run's bound work item has reached a
  // sensible near-terminal/terminal business status (the agent moved it via
  // transition-work-item). A run with no work item is exempt (checkFinalizeStatus
  // returns ok). Non-finalize nodes pass through untouched.
  const nodeGate: NodeGate = async (node) => {
    if (!isFinalizeStatusNode(node)) return { ok: true };
    const res = await checkFinalizeStatus(runId);
    return { ok: res.ok, reason: res.reason };
  };

  // Re-establish request context inside the detached work (DESIGN §4.2
  // landmine 2) so ownable scoping / secret resolution work for real executors.
  const outcome = await runWithRequestContext(
    { userEmail: cfg.userEmail, orgId: cfg.orgId ?? undefined },
    async () => {
      const scheduler = new Scheduler({
        cfg,
        db,
        executor,
        resolveTemplate,
        nodeGate,
      });
      return scheduler.run();
    },
  );

  // Persist status + totals. A `paused` run (parked on a human gate) is NOT
  // completed — leave completedAt null so run-resume can pick it back up.
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

  // PROPAGATE the run's deliverable + outcome to the bound work item so the UI
  // reflects reality (DESIGN §6.2a/§9): the item shows the PR/branch deliverable,
  // its run completion (execState done/failed), and a DELIVERED run advances its
  // business status to 待验收 (pending acceptance — a near-terminal in-progress
  // state; shipping stays a human step). The status change is LOGGED so the
  // watchdog + the UI history stay consistent. Best-effort: never fail the run.
  if (runRow.workItemId) {
    try {
      const runAfter = await db
        .select({ deliverable: schema.workflowRuns.deliverable })
        .from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.id, runId))
        .limit(1);
      const deliverable = runAfter[0]?.deliverable ?? null;
      const wiRows = await db
        .select()
        .from(schema.workItems)
        .where(eq(schema.workItems.id, runRow.workItemId))
        .limit(1);
      const wi = wiRows[0];
      if (wi) {
        const ts = nowIso();
        const patch: Record<string, unknown> = {
          execState:
            outcome.status === "done"
              ? "done"
              : outcome.status === "failed"
                ? "failed"
                : "idle",
          updatedAt: ts,
        };
        if (deliverable) patch.deliverable = deliverable;
        const delivered = outcome.status === "done" && !!deliverable;
        if (delivered && wi.status !== "待验收") {
          patch.status = "待验收";
          patch.statusCategory = "in-progress";
          await db.insert(schema.workItemStatusLog).values({
            id: newId("wsl"),
            workItemId: runRow.workItemId,
            runId,
            actor: cfg.userEmail,
            fromStatus: wi.status ?? "",
            toStatus: "待验收",
            blocked: 0,
            at: ts,
          });
        }
        await db
          .update(schema.workItems)
          .set(patch)
          .where(eq(schema.workItems.id, runRow.workItemId));
      }
    } catch {
      // best-effort — the run already finalized; UI propagation is advisory.
    }
  }

  // STATUS WATCHDOG (DESIGN §4.1 / §6.2b L2): a run bound to a work item that
  // reached done/failed without a logged status change is flagged stale. A run
  // with no work item is exempt (the watchdog returns early). Best-effort: a
  // reconcile failure must never fail the run itself.
  if (outcome.status === "done" || outcome.status === "failed") {
    try {
      await reconcileOnTerminal(runId);
    } catch {
      // swallow — the run already finalized; the watchdog is advisory.
    }
  }

  return outcome;
}

export { Scheduler } from "./scheduler.js";
export { EchoExecutor } from "./echo-executor.js";
export * from "./types.js";
