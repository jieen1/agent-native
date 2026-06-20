// The cross-task worker pool (DESIGN §6.4 / §13). The orchestrator pulls work
// items off the flat priority queue and runs N at a time, where N =
// concurrencyDegree. This is the `Promise.all(Array.from({length:N}, worker))`
// pattern (cli/workspace-dev.ts:1259): each worker loops claim → run → settle →
// claim next, and breaks when no item is claimable. Single-flight is guaranteed
// by the atomic claim (claim.ts) — one item is never double-claimed, so a
// running peak of exactly N items is the natural result of N workers.
//
// The pool is pure orchestration over the DB primitives; the only side effects
// are the run executions it delegates to. It NEVER touches business `status`
// (§6.4) — that is transition-work-item's job.

import { runWithRequestContext } from "@agent-native/core/server/request-context";
import {
  claimNextWorkItem,
  markRunning,
  releaseToBrain,
  settleWorkItem,
} from "./claim.js";
import { startRunForWorkItem } from "./run-work-item.js";
import { getConcurrencyDegree } from "./concurrency.js";
import { executeRun, type ExecuteRunOptions } from "../engine/index.js";

/** Per-item outcome the pool collected, for headless assertion / observability. */
export interface WorkerItemResult {
  workItemId: string;
  workerId: string;
  runId: string;
  status: string;
  tokensSpent: number;
  noWorkflow?: boolean;
}

export interface DrainQueueOptions {
  /** Pool width; defaults to the saved concurrencyDegree. */
  concurrency?: number;
  ownerEmail: string;
  orgId: string | null;
  /** Forwarded to executeRun (tests pin the echo executor / caps). */
  executeOpts?: ExecuteRunOptions;
  /**
   * Safety backstop on total items one drain handles, so a misbehaving producer
   * cannot spin a worker forever. Default generous.
   */
  maxItems?: number;
  /** Optional hook fired the instant an item is claimed (test sampling). */
  onClaim?: (workItemId: string, workerId: string) => void;
}

export interface DrainQueueResult {
  concurrency: number;
  processed: WorkerItemResult[];
}

/**
 * Run one worker loop: claim the next item, mark it running, execute its run,
 * settle done/failed, repeat until the queue yields nothing. The claim is
 * atomic, so two workers calling this concurrently never grab the same row.
 */
async function workerLoop(
  workerId: string,
  opts: DrainQueueOptions,
  budget: { remaining: number },
  out: WorkerItemResult[],
): Promise<void> {
  for (;;) {
    if (budget.remaining <= 0) break;
    const claimed = await claimNextWorkItem(workerId);
    if (!claimed) break; // queue drained (for this worker)
    budget.remaining -= 1;
    opts.onClaim?.(claimed.id, workerId);

    // Create the run row bound to the item (don't execute yet). If the item has
    // no resolvable workflow the run is already finalized `failed` here.
    const started = await startRunForWorkItem(claimed.id, {
      ownerEmail: opts.ownerEmail,
      orgId: opts.orgId,
      execute: false,
      executeOpts: opts.executeOpts,
    });

    // No workflow: settle the item failed directly from claimed (no run drive).
    if (started.noWorkflow) {
      await settleWorkItem(claimed.id, "failed");
      out.push({
        workItemId: claimed.id,
        workerId,
        runId: started.runId,
        status: "failed",
        tokensSpent: 0,
        noWorkflow: true,
      });
      continue;
    }

    // DYNAMIC-AUTHORED (DESIGN §6.3 order 3): no template resolved — the brain
    // must author the DAG. The worker pool does NOT execute a placeholder run.
    // Pause the item so the orchestrating agent picks it up (it builds + runs the
    // graph, then settles), rather than silently failing or double-running.
    if (started.dynamicAuthored) {
      await releaseToBrain(claimed.id);
      out.push({
        workItemId: claimed.id,
        workerId,
        runId: started.runId,
        status: "dynamic-authored",
        tokensSpent: 0,
      });
      continue;
    }

    // Flip claimed → running, guarded on our claim TOKEN so a reap between claim
    // and start doesn't double-run.
    const becameRunning = await markRunning(
      claimed.id,
      claimed.claimToken,
      started.runId,
    );
    if (!becameRunning) {
      // Reaped/cancelled out from under us between claim and run — drop it; the
      // requeued item will be re-claimed and get a fresh run. Record it.
      out.push({
        workItemId: claimed.id,
        workerId,
        runId: started.runId,
        status: "abandoned",
        tokensSpent: 0,
      });
      continue;
    }

    // Drive the run to completion, then settle the item's execState.
    let runStatus = started.status as string;
    let tokensSpent = started.tokensSpent;
    try {
      const outcome = await executeRun(started.runId, opts.executeOpts ?? {});
      runStatus = outcome.status;
      tokensSpent = outcome.tokensSpent;
    } catch {
      runStatus = "failed";
    }
    const settledTo = runStatus === "done" ? "done" : "failed";
    await settleWorkItem(claimed.id, settledTo);

    out.push({
      workItemId: claimed.id,
      workerId,
      runId: started.runId,
      status: settledTo,
      tokensSpent,
    });
  }
}

/**
 * Drain the queue with a pool of `concurrency` workers. Returns when every
 * worker's loop breaks (the queue is empty). The running peak is bounded by the
 * pool width because the atomic claim hands each queued row to exactly one
 * worker. Each worker runs inside its own request context (independent scoping).
 */
export async function drainQueue(
  opts: DrainQueueOptions,
): Promise<DrainQueueResult> {
  const concurrency = opts.concurrency ?? (await getConcurrencyDegree());
  const out: WorkerItemResult[] = [];
  const budget = { remaining: opts.maxItems ?? 10_000 };

  await Promise.all(
    Array.from({ length: concurrency }, (_unused, i) => {
      const workerId = `worker-${i}`;
      return runWithRequestContext(
        { userEmail: opts.ownerEmail, orgId: opts.orgId ?? undefined },
        () => workerLoop(workerId, opts, budget, out),
      );
    }),
  );

  return { concurrency, processed: out };
}
