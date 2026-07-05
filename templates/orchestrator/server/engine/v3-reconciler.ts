// V3 Event-Driven Reconciler (DESIGN §9, IMPLEMENTATION §A)
//
// Replaces V2's one-shot scheduler with an event-driven tick loop.
// Each tick acquires a PG advisory lock, reads current state, dispatches
// ready nodes, cascades failures, and writes events.  Pause / resume /
// cancel are first-class operations.
//
// Gap fixes in this revision:
//   G10 — guard evaluation + cascade-skip downstream all-skipped deps (fixpoint)
//   G12 — parallel_over: eval items_from as expression from real dep artifact;
//          freeze item set in event; inject item+fanout_index per child;
//          copy inline/referenced body onto child.
//          loop: sequential body[] ids per iteration; real artifact in context;
//          until/previous_iteration/history use real content; key by iteration.
//   G16 — atomic status-conditioned UPDATE (WHERE status IN (pending,ready));
//          only dispatch when rowcount == 1.
//   G17 — fire-and-track spawn; re-trigger tick on completion; running is
//          observable across ticks.
//   G18 — global pool capacity + per-parallel_over max_concurrency; ordered
//          by (run.priority desc, queued_at asc).
//   G19 — node.retry (max/on/backoff) with exponential backoff on
//          transient/schema-violation before failing.
//   G20 — honor on_failure:"continue" before declaring run failed.

import { eq, and, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  v3Runs,
  v3Nodes,
  v3Events,
  v3Artifacts,
  brainThreads,
} from "../db/v3-schema.js";
import { getDbExec } from "../db/index.js";
import type { InferSelectModel, InferInsertModel } from "drizzle-orm";
import { evaluateExpression } from "./expression-parser.js";
import type { ExpressionContext } from "./expression-parser.js";

// ── Types ────────────────────────────────────────────────────────────────────

type RunRow = InferSelectModel<typeof v3Runs>;
type NodeRow = InferSelectModel<typeof v3Nodes>;
type EventInsert = InferInsertModel<typeof v3Events>;

/** Retry policy for a node (§12, G19). */
export interface V3RetryPolicy {
  max?: number;
  on?: string[];
  backoff?: "exponential" | "linear" | "fixed";
  initial_ms?: number;
  max_ms?: number;
}

export interface V3NodeDag {
  id: string;
  type: "agent" | "parallel_over" | "loop" | "human_gate";
  deps?: string[];
  /** G12: body may be a node-id string, an array of node-id strings (loop), or an inline agent node. */
  body?: string | string[] | Record<string, unknown>;
  items_from?: string;
  max_concurrency?: number;
  until?: string;
  maxIterations?: number;
  max_iterations?: number;
  /** G10: condition expression; false → skip + cascade */
  guard?: string;
  /** G19: retry policy */
  retry?: V3RetryPolicy;
  /** G20: on_failure:"continue" allows run to complete despite this node failing */
  on_failure?: "continue" | "fail";
  [key: string]: unknown;
}

export interface V3Dispatcher {
  /**
   * Spawn an agent node.  Returns the spawn id written to v3_spawns.
   * Interface is unchanged — callers may not add parameters.
   */
  spawn(node: NodeRow, runId: string): Promise<string>;
}

// Terminal node statuses (no further work possible)
const TERMINAL_STATUSES = new Set(["done", "failed", "skipped"]);
const RESOLVED_STATUSES = new Set(["done", "skipped"]);

// G18: default pool capacity; overridable via constructor option.
const DEFAULT_POOL_CAPACITY = 8;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Generate a unique id for DB rows. */
function uid(): string {
  return crypto.randomUUID();
}

/** Compute exponential backoff delay in ms. */
function computeBackoffMs(
  attempt: number,
  policy: V3RetryPolicy,
): number {
  const initial = policy.initial_ms ?? 1000;
  const maxMs = policy.max_ms ?? 30_000;
  const backoff = policy.backoff ?? "exponential";
  let delay: number;
  if (backoff === "exponential") {
    delay = initial * Math.pow(2, attempt - 1);
  } else if (backoff === "linear") {
    delay = initial * attempt;
  } else {
    delay = initial;
  }
  return Math.min(delay, maxMs);
}

// ── Reconciler ───────────────────────────────────────────────────────────────

export class V3Reconciler {
  private readonly db: PostgresJsDatabase;
  private readonly dispatcher: V3Dispatcher;
  /** G18: global spawn pool capacity */
  private readonly poolCapacity: number;

  constructor(
    db: PostgresJsDatabase,
    dispatcher: V3Dispatcher,
    poolCapacity: number = DEFAULT_POOL_CAPACITY,
  ) {
    this.db = db;
    this.dispatcher = dispatcher;
    this.poolCapacity = poolCapacity;
  }

  // ─── tick ───────────────────────────────────────────────────────────────

  /**
   * Single reconciler tick for a given run.
   *
   * Steps:
   *  0. Acquire PG advisory lock (skip if another tick owns it)
   *  1. Read run — skip if not running
   *  2. Read all nodes
   *  3. G10: evaluate guard expressions; cascade-skip downstream when deps all-skipped
   *  4. Find ready nodes (all deps resolved/skipped) + G18 capacity check
   *  5. Dispatch ready nodes by type (G16 atomic CAS, G17 fire-and-track)
   *  6. Check run completion (G20 on_failure:continue)
   *  7. All mutations are recorded as v3_events
   */
  public async tick(runId: string): Promise<void> {
    // 0. Advisory lock — non-blocking; skip if another tick holds it.
    // hashtext() derives the bigint lock id inside Postgres; runId is a BOUND
    // parameter ($1), never string-concatenated into the SQL text.
    //
    // TRANSACTION-SCOPED, not session-scoped: pg_try_advisory_xact_lock is
    // held by the transaction and auto-released on commit/rollback, on the
    // SAME connection the lock was taken on. The prior session-scoped
    // pg_try_advisory_lock/pg_advisory_unlock pair was a foot-gun on a POOLED
    // client — acquire and release could land on two different pooled
    // connections, which either errors ("you don't own a lock") or, worse,
    // leaks the lock forever and wedges every future tick for this run. The
    // xact lock cannot leak: it always releases when the transaction ends,
    // even if `_tickLocked` throws. `_tickLocked` itself keeps running on
    // `this.db` (the pool) — only the lock acquisition needs the single
    // dedicated connection a transaction provides.
    await getDbExec().transaction!(async (tx) => {
      const { rows } = await tx.execute({
        sql: "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked",
        args: [runId],
      });
      if (!(rows[0]?.locked ?? false)) {
        return; // Another tick in progress — bail silently
      }
      await this._tickLocked(runId);
    });
  }

  /** Core tick logic (assumes lock is already held). */
  private async _tickLocked(runId: string): Promise<void> {
    // 1. Read run
    const [run] = await this.db
      .select()
      .from(v3Runs)
      .where(eq(v3Runs.id, runId));

    if (!run) {
      return; // Run doesn't exist
    }

    // Skip terminal or paused runs
    if (
      run.status === "paused" ||
      run.status === "done" ||
      run.status === "failed" ||
      run.status === "cancelled"
    ) {
      return;
    }

    // Transition pending → running
    if (run.status === "pending") {
      await this.db
        .update(v3Runs)
        .set({
          status: "running",
          startedAt: new Date(),
        })
        .where(eq(v3Runs.id, runId));

      await this.writeEvent(runId, "run.started", {});
    }

    // 2. Read all nodes for this run
    const nodes = await this.db
      .select()
      .from(v3Nodes)
      .where(eq(v3Nodes.runId, runId));

    if (nodes.length === 0) {
      // Empty DAG — mark complete immediately
      await this.finalizeRun(runId, "done", []);
      return;
    }

    // Build adjacency helpers (in-memory from DAG stored on run/nodes)
    const dag = this.loadDag(run, nodes);

    // ── G10: Evaluate guard expressions + cascade-skip ────────────────────
    // Build interpolation context from run inputs (dep artifacts require DB — use
    // artifact cache from the event store here, populated lazily per dep).
    await this.evaluateGuardsAndSkip(runId, run, nodes, dag);

    // Re-read nodes after guard skip mutations
    const nodesAfterGuards = await this.db
      .select()
      .from(v3Nodes)
      .where(eq(v3Nodes.runId, runId));

    // 3. Detect failed nodes (non-continue) → cascade skip all downstream
    const dagNodeMap = new Map(dag.map((d) => [d.id, d]));
    const failedNodes = nodesAfterGuards.filter((n) => n.status === "failed");
    const failedCascadeIds = new Set(
      failedNodes
        .filter((n) => {
          const dagNode = dagNodeMap.get(n.nodeIdInDag);
          return (dagNode?.on_failure ?? "fail") !== "continue";
        })
        .map((n) => n.nodeIdInDag),
    );

    if (failedCascadeIds.size > 0) {
      // Cascade: skip all pending nodes whose upstream has a failed ancestor
      const toSkip = nodesAfterGuards.filter(
        (n) =>
          n.status === "pending" &&
          this.hasFailedAncestor(n.nodeIdInDag, dag, failedCascadeIds, new Set()),
      );

      if (toSkip.length > 0) {
        const skipNodeIds = toSkip.map((n) => n.id);
        await this.db
          .update(v3Nodes)
          .set({ status: "skipped", error: "Upstream node failed" })
          .where(
            and(
              eq(v3Nodes.runId, runId),
              inArray(v3Nodes.id, skipNodeIds),
            ),
          );

        for (const fn of failedNodes.filter((n) => failedCascadeIds.has(n.nodeIdInDag))) {
          await this.writeEvent(runId, "node.failed", {
            nodeId: fn.nodeIdInDag,
            error: fn.error,
          });
        }

        for (const skipped of toSkip) {
          await this.writeEvent(runId, "node.skipped", {
            nodeId: skipped.nodeIdInDag,
            reason: "Upstream failure",
          });
        }
      }

      // G20: only declare run failed if any non-continue node failed
      await this.finalizeRun(runId, "failed", nodesAfterGuards);
      await this.writeEvent(runId, "run.failed", {});
      return;
    }

    // 4. Find ready nodes (all deps resolved or skipped)
    const nodeMap = this.buildNodeMap(nodesAfterGuards);

    // G18: count currently running nodes across ALL runs to respect pool capacity
    const globalRunningCount = await this.countGlobalRunning();
    let availableSlots = this.poolCapacity - globalRunningCount;

    // Build ordered candidate list: pending nodes with all deps satisfied
    // Order: run.priority desc, node.startedAt (queued_at proxy) asc
    const pendingNodes = nodesAfterGuards.filter(
      (n) => n.status === "pending" || n.status === "ready",
    );

    const readyCandidates: NodeRow[] = [];
    for (const node of pendingNodes) {
      if (TERMINAL_STATUSES.has(node.status)) continue;
      if (node.status === "awaiting-approval") continue;
      if (node.status === "running") continue;

      const depIds = this.getNodeDeps(node, dag);
      const depsSatisfied = depIds.every((depId) => {
        const depNode = this.findLatestNode(nodeMap, depId);
        return depNode !== undefined && RESOLVED_STATUSES.has(depNode.status);
      });

      if (depsSatisfied) {
        readyCandidates.push(node);
      }
    }

    // Sort by (run.priority desc, startedAt/id asc) for ordering — G18
    readyCandidates.sort((a, b) => {
      // priority comes from run; all these nodes are in the same run — so
      // break ties by startedAt (null = queued/pending; treat null as earliest)
      const ta = a.startedAt?.getTime() ?? 0;
      const tb = b.startedAt?.getTime() ?? 0;
      return ta - tb;
    });

    // 5. Dispatch ready nodes (G16, G17, G18)
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];

    // Per-parallel_over concurrency tracking
    const concurrencyCounters = new Map<string, number>();

    for (const node of readyCandidates) {
      // G18: global pool capacity gate
      if (availableSlots <= 0 && node.type === "agent") {
        break;
      }

      // G18: per-parallel_over max_concurrency gate
      if (node.nodeIdInDag.includes(":[")) {
        // Fanout child — identify parent
        const parentId = node.nodeIdInDag.split(":[")[0];
        const parentDagNode = dagNodeMap.get(parentId);
        const maxConc = (parentDagNode as V3NodeDag | undefined)?.max_concurrency;
        if (maxConc !== undefined) {
          const currentConc = concurrencyCounters.get(parentId) ?? 0;
          // Count already-running children of this parent
          const runningChildren = nodesAfterGuards.filter(
            (n) =>
              n.nodeIdInDag.startsWith(`${parentId}:[`) &&
              n.status === "running",
          ).length;
          if (runningChildren + currentConc >= maxConc) {
            continue; // skip until a slot opens
          }
          concurrencyCounters.set(parentId, currentConc + 1);
        }
      }

      const result = await this.dispatchNode(runId, run, node, nodesAfterGuards, nodeMap, dag);
      events.push(...result.events);
      if (result.slotConsumed) {
        availableSlots--;
      }
    }

    // Write dispatch events
    for (const ev of events) {
      await this.writeEvent(runId, ev.kind, ev.payload);
    }

    // 6. Check run completion — re-read nodes to catch dispatch-side changes
    const updatedNodes = await this.db
      .select()
      .from(v3Nodes)
      .where(eq(v3Nodes.runId, runId));

    const hasCascadeFail = updatedNodes.some(
      (n) =>
        n.status === "failed" &&
        (dagNodeMap.get(n.nodeIdInDag)?.on_failure ?? "fail") !== "continue",
    );
    const allDoneOrSkipped = updatedNodes.every((n) =>
      RESOLVED_STATUSES.has(n.status),
    );
    const allTerminalOrWaiting = updatedNodes.every((n) =>
      TERMINAL_STATUSES.has(n.status) || n.status === "awaiting-approval",
    );
    const anyWaiting = updatedNodes.some((n) => n.status === "awaiting-approval");

    const runGoingTerminal = hasCascadeFail || allDoneOrSkipped || (allTerminalOrWaiting && !anyWaiting);

    if (hasCascadeFail) {
      await this.finalizeRun(runId, "failed", updatedNodes);
      await this.writeEvent(runId, "run.failed", {});
    } else if (allDoneOrSkipped) {
      // G20: if all terminal and no blocking failures, run is done
      await this.finalizeRun(runId, "done", updatedNodes);
      await this.writeEvent(runId, "run.completed", {});
    } else if (allTerminalOrWaiting && !anyWaiting) {
      await this.finalizeRun(runId, "done", updatedNodes);
      await this.writeEvent(runId, "run.completed", {});
    }
    // If some nodes are awaiting-approval, run stays "running" —
    // resume() after human_gate resolution will re-tick.

    // Event-driven NODE-level brain wake. When the run is NOT itself going
    // terminal this tick (finalizeRun handles that via maybeWakeOrchestrator),
    // wake the monitoring brain for each node that JUST became terminal so it
    // does a short check-in turn instead of busy-polling. Idempotent +
    // best-effort — never blocks reconcile.
    if (!runGoingTerminal) {
      try {
        await this.maybeWakeOrchestratorOnNode(runId, run.tags, updatedNodes);
      } catch {
        // Advisory only.
      }
    }
  }

  // ─── G10: Guard Evaluation ──────────────────────────────────────────────

  /**
   * For every pending node whose deps are ALL resolved (done or skipped),
   * evaluate its guard expression.  If false → mark skipped + emit event.
   * Then run to a fixpoint: cascade-skip any pending node whose ALL deps
   * are now skipped (regardless of guard).
   */
  private async evaluateGuardsAndSkip(
    runId: string,
    run: RunRow,
    nodes: NodeRow[],
    dag: V3NodeDag[],
  ): Promise<void> {
    // Work on a mutable copy of statuses so we can fixpoint in-memory
    const statusMap = new Map<string, string>(nodes.map((n) => [n.id, n.status]));
    // nodeIdInDag → latest status
    const dagStatusMap = this.buildDagStatusMap(nodes, statusMap);

    let changed = true;
    while (changed) {
      changed = false;
      for (const node of nodes) {
        if (statusMap.get(node.id) !== "pending") continue;

        const depIds = this.getNodeDeps(node, dag);
        const dagNode = dag.find((d) => d.id === node.nodeIdInDag);

        // All deps must be resolved (done or skipped) to evaluate guard
        const allDepsResolved = depIds.every((depId) => {
          const s = dagStatusMap.get(depId);
          return s !== undefined && RESOLVED_STATUSES.has(s);
        });
        if (!allDepsResolved) continue;

        // G10: cascade-skip if ALL deps are skipped
        const allDepsSkipped =
          depIds.length > 0 &&
          depIds.every((depId) => dagStatusMap.get(depId) === "skipped");

        if (allDepsSkipped) {
          // Cascade skip — no guard needed
          statusMap.set(node.id, "skipped");
          dagStatusMap.set(node.nodeIdInDag, "skipped");
          changed = true;
          await this.db
            .update(v3Nodes)
            .set({ status: "skipped", error: "All upstream nodes skipped" })
            .where(eq(v3Nodes.id, node.id));
          await this.writeEvent(runId, "node.skipped", {
            nodeId: node.nodeIdInDag,
            reason: "cascade: all deps skipped",
          });
          continue;
        }

        // Evaluate guard if present
        const guardExpr = dagNode?.guard as string | undefined;
        if (!guardExpr) continue;

        let guardPassed = true;
        let guardError: unknown = null;
        try {
          const ctx = await this.buildGuardContext(run, node, nodes, dag);
          const result = evaluateExpression(guardExpr, ctx);
          guardPassed = this.toBool(result);
        } catch (err) {
          // A guard that cannot be evaluated must NOT let the node through.
          // Capture the error and fail the node below (fail-loud) instead of
          // silently treating a broken guard as a pass.
          guardError = err;
        }

        if (guardError) {
          // Guard eval error → FAIL the node with a clear errorClass so a broken
          // guard is visible and never silently admits the node.
          const msg =
            guardError instanceof Error
              ? guardError.message
              : String(guardError);
          statusMap.set(node.id, "failed");
          dagStatusMap.set(node.nodeIdInDag, "failed");
          changed = true;
          await this.db
            .update(v3Nodes)
            .set({
              status: "failed",
              error: `guard-eval-error: ${msg}`.slice(0, 1000),
              completedAt: new Date(),
            })
            .where(eq(v3Nodes.id, node.id));
          await this.writeEvent(runId, "node.failed", {
            nodeId: node.nodeIdInDag,
            reason: "guard-eval-error",
            errorClass: "guard-eval-error",
            guard: guardExpr,
            error: msg,
          });
          continue;
        }

        if (!guardPassed) {
          statusMap.set(node.id, "skipped");
          dagStatusMap.set(node.nodeIdInDag, "skipped");
          changed = true;
          await this.db
            .update(v3Nodes)
            .set({ status: "skipped", error: "Guard expression evaluated to false" })
            .where(eq(v3Nodes.id, node.id));
          await this.writeEvent(runId, "node.skipped", {
            nodeId: node.nodeIdInDag,
            reason: "guard:false",
            guard: guardExpr,
          });
        }
      }
    }
  }

  /** Build a map nodeIdInDag → latest status using the in-memory status map. */
  private buildDagStatusMap(
    nodes: NodeRow[],
    statusMap: Map<string, string>,
  ): Map<string, string> {
    const dagStatusMap = new Map<string, string>();
    for (const node of nodes) {
      const status = statusMap.get(node.id) ?? node.status;
      // Use highest iteration to represent the latest status per dag id
      const existing = dagStatusMap.get(node.nodeIdInDag);
      if (existing === undefined || this.statusPriority(status) > this.statusPriority(existing)) {
        dagStatusMap.set(node.nodeIdInDag, status);
      }
    }
    return dagStatusMap;
  }

  private statusPriority(status: string): number {
    // Higher = "more done"
    const p: Record<string, number> = {
      pending: 0, ready: 1, running: 2, "awaiting-approval": 2,
      done: 3, skipped: 3, failed: 3,
    };
    return p[status] ?? 0;
  }

  /**
   * Build an ExpressionContext for guard evaluation.
   * Reads dep artifacts from DB to populate deps[id].output.
   */
  private async buildGuardContext(
    run: RunRow,
    node: NodeRow,
    allNodes: NodeRow[],
    dag: V3NodeDag[],
  ): Promise<ExpressionContext> {
    const depIds = this.getNodeDeps(node, dag);
    const deps: ExpressionContext["deps"] = {};
    const nodeMap = this.buildNodeMap(allNodes);

    for (const depId of depIds) {
      const depNode = this.findLatestNode(nodeMap, depId);
      if (!depNode) {
        deps[depId] = { output: undefined };
        continue;
      }
      const output = await this.readArtifactContent(depNode.outputArtifactId);
      deps[depId] = { output };
    }

    const inputs = (run.inputs ?? {}) as Record<string, unknown>;
    return {
      inputs,
      deps,
      iteration: node.iteration > 0 ? node.iteration : undefined,
    };
  }

  // ─── Node Dispatch ──────────────────────────────────────────────────────

  /**
   * Dispatch a single ready node based on its type.
   * Returns events to be written and whether a pool slot was consumed.
   */
  private async dispatchNode(
    runId: string,
    run: RunRow,
    node: NodeRow,
    allNodes: NodeRow[],
    nodeMap: Map<string, NodeRow[]>,
    dag: V3NodeDag[],
  ): Promise<{ events: Array<{ kind: string; payload: Record<string, unknown> }>; slotConsumed: boolean }> {
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];

    switch (node.type) {
      case "agent": {
        // G16: Atomic status-conditioned UPDATE — only dispatch when rowcount == 1
        const updateResult = await getDbExec().execute({
          sql: `UPDATE v3_nodes SET status = 'running', started_at = now()
           WHERE id = $1
             AND status IN ('pending', 'ready')
           RETURNING id`,
          args: [node.id],
        });

        if ((updateResult.rows?.length ?? 0) !== 1) {
          // Another tick already claimed this node — skip
          return { events, slotConsumed: false };
        }

        // G17: fire-and-track — do not synchronously await the entire spawn.
        // Schedule the spawn asynchronously and re-trigger a tick when done.
        // fireAndTrackSpawn owns its retry/fail bookkeeping; an error that still
        // escapes it is a real dispatch fault — LOG it loudly (never silently
        // swallow) while keeping this call deliberately fire-and-forget.
        this.fireAndTrackSpawn(runId, node, dag).catch((err) => {
          console.error(
            `[v3-reconciler] fireAndTrackSpawn escaped for node ` +
              `${node.nodeIdInDag} (run ${runId}):`,
            err,
          );
        });

        events.push({
          kind: "node.dispatched",
          payload: { nodeId: node.nodeIdInDag },
        });

        return { events, slotConsumed: true };
      }

      case "parallel_over": {
        const dagNode = dag.find((d) => d.id === node.nodeIdInDag) as V3NodeDag | undefined;

        // G12: Resolve or retrieve frozen items from event store
        const items = await this.getFrozenFanoutItems(runId, node, allNodes, nodeMap, dagNode, dag, run);

        if (items === null) {
          // items_from expression failed — fail the node
          await this.db
            .update(v3Nodes)
            .set({ status: "failed", error: "items_from expression failed to resolve an array", completedAt: new Date() })
            .where(eq(v3Nodes.id, node.id));
          events.push({ kind: "node.failed", payload: { nodeId: node.nodeIdInDag, error: "items_from expression error" } });
          return { events, slotConsumed: false };
        }

        // G12: Copy inline or referenced body spec onto each child
        const bodySpec = dagNode?.body;
        const bodyPrompt = typeof bodySpec === "object" && bodySpec !== null && !Array.isArray(bodySpec)
          ? (bodySpec as Record<string, unknown>).prompt as string | undefined
          : undefined;
        const bodyAgent = typeof bodySpec === "object" && bodySpec !== null && !Array.isArray(bodySpec)
          ? (bodySpec as Record<string, unknown>).agent as string | undefined
          : undefined;
        const bodyId = typeof bodySpec === "string" ? bodySpec : undefined;

        for (let i = 0; i < items.length; i++) {
          const childNodeId = `${node.nodeIdInDag}:[${i}]`;

          // Check if fanout child already exists (re-entrant tick safety)
          const existing = allNodes.find(
            (n) => n.nodeIdInDag === childNodeId && n.fanoutIndex === i,
          );
          if (existing) {
            continue;
          }

          // Fanout children are instances of the body node
          const childNode: Omit<NodeRow, "ownerEmail" | "orgId"> & {
            ownerEmail: string;
            orgId: null | string;
          } = {
            id: uid(),
            runId,
            // G12: Embed body prompt/agent on the child node via nodeIdInDag
            // The dispatcher resolves the agent from the DAG node, so we need
            // a nodeIdInDag that the dispatcher can look up. For inline bodies,
            // we store the parent's nodeIdInDag so the dispatcher can find it.
            nodeIdInDag: childNodeId,
            type: "agent",
            status: "pending",
            iteration: 0,
            fanoutIndex: i,
            currentSpawnId: null,
            outputArtifactId: null,
            startedAt: null,
            completedAt: null,
            error: null,
            ownerEmail: node.ownerEmail,
            orgId: node.orgId,
          };

          await this.db.insert(v3Nodes).values(childNode as any);

          events.push({
            kind: "node.fanout-created",
            payload: {
              parentId: node.nodeIdInDag,
              childId: childNodeId,
              fanoutIndex: i,
              item: items[i],
              bodyId: bodyId ?? null,
              bodyPrompt: bodyPrompt ?? null,
              bodyAgent: bodyAgent ?? null,
            },
          });
        }

        // Mark the parallel_over node itself as done (its job is fanout)
        await this.db
          .update(v3Nodes)
          .set({ status: "done", completedAt: new Date() })
          .where(eq(v3Nodes.id, node.id));

        events.push({
          kind: "node.resolved",
          payload: { nodeId: node.nodeIdInDag, resolvedAs: "fanout" },
        });
        return { events, slotConsumed: false };
      }

      case "loop": {
        const dagNode = dag.find((d) => d.id === node.nodeIdInDag) as V3NodeDag | undefined;
        const untilExpr = (dagNode?.until as string | undefined) ?? "false";
        const maxIter = (dagNode?.max_iterations as number | undefined)
          ?? (dagNode?.maxIterations as number | undefined)
          ?? 100;

        // G12: body[] is an array of node-ids run sequentially per iteration
        const bodyRaw = dagNode?.body;
        const bodyIds: string[] = Array.isArray(bodyRaw)
          ? (bodyRaw as string[])
          : typeof bodyRaw === "string"
            ? [bodyRaw]
            : [];

        // Count completed body iterations (based on body[last] nodes with status done)
        const lastBodyId = bodyIds.length > 0 ? bodyIds[bodyIds.length - 1] : null;
        const completedIterations = lastBodyId
          ? allNodes.filter(
              (n) =>
                n.nodeIdInDag === `${node.nodeIdInDag}/${lastBodyId}` &&
                n.status === "done",
            ).length
          : allNodes.filter(
              (n) => n.nodeIdInDag === `${node.nodeIdInDag}/body` && n.status === "done",
            ).length;

        // G12: build REAL expression context for loop until/history/previous_iteration
        let shouldStop = false;
        try {
          const exprCtx = await this.buildLoopExpressionContext(
            node,
            allNodes,
            nodeMap,
            dag,
            bodyIds,
            run,
          );
          const result = evaluateExpression(untilExpr, exprCtx);
          shouldStop = this.toBool(result);
        } catch {
          // Expression error — continue looping (body may not have output yet)
          shouldStop = false;
        }

        if (shouldStop || completedIterations >= maxIter) {
          // Loop resolved
          await this.db
            .update(v3Nodes)
            .set({ status: "done", completedAt: new Date() })
            .where(eq(v3Nodes.id, node.id));

          events.push({
            kind: "node.resolved",
            payload: {
              nodeId: node.nodeIdInDag,
              resolvedAs: "loop-done",
              iterations: completedIterations,
              maxIterations: maxIter,
            },
          });

          if (completedIterations >= maxIter && !shouldStop) {
            events.push({
              kind: "loop.max-iterations-reached",
              payload: {
                nodeId: node.nodeIdInDag,
                iterations: completedIterations,
              },
            });
          }
        } else {
          // G12: Create new iteration body nodes — one per body[] id, sequentially
          const nextIter = completedIterations + 1;

          if (bodyIds.length === 0) {
            // Legacy: single body node
            const iterNodeId = `${node.nodeIdInDag}/body`;
            const iterNode: Omit<NodeRow, "ownerEmail" | "orgId"> & {
              ownerEmail: string;
              orgId: null | string;
            } = {
              id: uid(),
              runId,
              nodeIdInDag: iterNodeId,
              type: "agent",
              status: "pending",
              iteration: nextIter,
              fanoutIndex: 0,
              currentSpawnId: null,
              outputArtifactId: null,
              startedAt: null,
              completedAt: null,
              error: null,
              ownerEmail: node.ownerEmail,
              orgId: node.orgId,
            };
            await this.db.insert(v3Nodes).values(iterNode as any);
            events.push({
              kind: "loop.iteration-created",
              payload: {
                loopId: node.nodeIdInDag,
                iteration: nextIter,
                bodyId: iterNodeId,
              },
            });
          } else {
            // G12: Create body nodes keyed by iteration — first one is pending,
            // subsequent ones depend on the previous (sequential within iter).
            // Only create all body nodes for iteration; they will naturally
            // depend on each other through the node map mechanism.
            for (let bi = 0; bi < bodyIds.length; bi++) {
              const bodyNodeId = bodyIds[bi]!;
              const iterNodeId = `${node.nodeIdInDag}/${bodyNodeId}`;

              // Check if already exists for this iteration
              const existing = allNodes.find(
                (n) => n.nodeIdInDag === iterNodeId && n.iteration === nextIter,
              );
              if (existing) continue;

              const iterNode: Omit<NodeRow, "ownerEmail" | "orgId"> & {
                ownerEmail: string;
                orgId: null | string;
              } = {
                id: uid(),
                runId,
                nodeIdInDag: iterNodeId,
                type: "agent",
                status: bi === 0 ? "pending" : "pending", // all pending; deps handled below
                iteration: nextIter,
                fanoutIndex: bi, // use fanoutIndex to encode order within the body sequence
                currentSpawnId: null,
                outputArtifactId: null,
                startedAt: null,
                completedAt: null,
                error: null,
                ownerEmail: node.ownerEmail,
                orgId: node.orgId,
              };

              await this.db.insert(v3Nodes).values(iterNode as any);
            }

            events.push({
              kind: "loop.iteration-created",
              payload: {
                loopId: node.nodeIdInDag,
                iteration: nextIter,
                bodyIds,
              },
            });
          }
        }
        return { events, slotConsumed: false };
      }

      case "human_gate": {
        await this.db
          .update(v3Nodes)
          .set({ status: "awaiting-approval" })
          .where(eq(v3Nodes.id, node.id));

        events.push({
          kind: "node.awaiting-approval",
          payload: { nodeId: node.nodeIdInDag },
        });
        return { events, slotConsumed: false };
      }

      default:
        // Unknown type — skip
        return { events, slotConsumed: false };
    }
  }

  // ─── G17: Fire-and-Track Spawn ──────────────────────────────────────────

  /**
   * G17: Execute a spawn asynchronously, update node status on completion,
   * and re-trigger a tick so the next wave of nodes can proceed.
   */
  private async fireAndTrackSpawn(
    runId: string,
    node: NodeRow,
    dag: V3NodeDag[],
  ): Promise<void> {
    const dagNode = dag.find((d) => d.id === node.nodeIdInDag) as V3NodeDag | undefined;
    const retryPolicy = dagNode?.retry as V3RetryPolicy | undefined;

    const maxAttempts = (retryPolicy?.max ?? 0) + 1; // max = additional retries
    const retryOn = retryPolicy?.on ?? ["transient", "schema-violation"];

    let attempt = 0;
    let lastError: unknown = null;

    while (attempt < maxAttempts) {
      attempt++;

      if (attempt > 1) {
        // G19: Exponential backoff before retry
        const backoffMs = computeBackoffMs(attempt - 1, retryPolicy ?? {});
        await new Promise((r) => setTimeout(r, backoffMs));

        // Re-attempt: transition node back to running atomically
        const rerun = await getDbExec().execute({
          sql: `UPDATE v3_nodes SET status = 'running', started_at = now(), error = null
           WHERE id = $1
             AND status = 'failed'
           RETURNING id`,
          args: [node.id],
        });
        if ((rerun.rows?.length ?? 0) !== 1) {
          // Node was cancelled or otherwise modified — abort retry
          return;
        }
      }

      try {
        const spawnId = await this.dispatcher.spawn(node, runId);

        // Update currentSpawnId on success
        await this.db
          .update(v3Nodes)
          .set({ currentSpawnId: spawnId })
          .where(eq(v3Nodes.id, node.id));

        // spawn() in V3Dispatcher already sets node.status = "done" on success
        // and "failed" on schema-violation.  Re-trigger tick.
        await this.writeEvent(runId, "spawn.done", { nodeId: node.nodeIdInDag, spawnId });
        await this.tick(runId);
        return;
      } catch (err) {
        lastError = err;
        const errClass = this.classifyError(err);

        await this.writeEvent(runId, "spawn.failed", {
          nodeId: node.nodeIdInDag,
          attempt,
          error: err instanceof Error ? err.message : String(err),
          errorClass: errClass,
        });

        // G19: Should we retry?
        const shouldRetry =
          attempt < maxAttempts &&
          retryOn.includes(errClass);

        if (!shouldRetry) {
          // Permanently fail the node
          await this.db
            .update(v3Nodes)
            .set({
              status: "failed",
              error: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
              completedAt: new Date(),
            })
            .where(eq(v3Nodes.id, node.id));

          await this.writeEvent(runId, "node.failed", {
            nodeId: node.nodeIdInDag,
            error: err instanceof Error ? err.message : String(err),
            attempt,
          });

          // Re-trigger tick so the run can be finalized (fail cascade / completion check)
          await this.tick(runId);
          return;
        }

        // Mark failed for retry (will be re-set to running above)
        await this.db
          .update(v3Nodes)
          .set({
            status: "failed",
            error: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
          })
          .where(eq(v3Nodes.id, node.id));
      }
    }

    // Exhausted retries
    await this.db
      .update(v3Nodes)
      .set({
        status: "failed",
        error: (lastError instanceof Error ? lastError.message : String(lastError)).slice(0, 1000),
        completedAt: new Date(),
      })
      .where(eq(v3Nodes.id, node.id));

    await this.writeEvent(runId, "node.failed", {
      nodeId: node.nodeIdInDag,
      error: lastError instanceof Error ? lastError.message : String(lastError),
      retriesExhausted: true,
    });

    await this.tick(runId);
  }

  // ─── G12: Expression Context for Loop ──────────────────────────────────

  /**
   * G12: Build ExpressionContext for evaluating loop `until` expressions.
   * Reads REAL dep artifact content from v3_artifacts (not null placeholders).
   * Populates previous_iteration and history from completed body iterations.
   */
  private async buildLoopExpressionContext(
    loopNode: NodeRow,
    allNodes: NodeRow[],
    nodeMap: Map<string, NodeRow[]>,
    dag: V3NodeDag[],
    bodyIds: string[],
    run: RunRow,
  ): Promise<ExpressionContext> {
    const depIds = this.getNodeDeps(loopNode, dag);

    const deps: ExpressionContext["deps"] = {};

    // Load real dep artifacts
    for (const depId of depIds) {
      const depNode = this.findLatestNode(nodeMap, depId);
      if (depNode) {
        const output = await this.readArtifactContent(depNode.outputArtifactId);
        deps[depId] = { output };
      }
    }

    // G12: Build previous_iteration and history from completed body nodes
    // history[i] = { bodyNodeId: { output } } for iteration i
    const historyByIteration = new Map<number, Record<string, { output?: unknown }>>();

    for (const bodyId of bodyIds) {
      const iterNodeId = `${loopNode.nodeIdInDag}/${bodyId}`;
      const bodyRows = allNodes.filter(
        (n) => n.nodeIdInDag === iterNodeId && n.status === "done",
      );
      for (const bodyRow of bodyRows) {
        const output = await this.readArtifactContent(bodyRow.outputArtifactId);
        const iterEntry = historyByIteration.get(bodyRow.iteration) ?? {};
        iterEntry[bodyId] = { output };
        historyByIteration.set(bodyRow.iteration, iterEntry);
        // deps[bodyId].output = latest iteration output
        if (!deps[bodyId] || bodyRow.iteration > ((deps[bodyId] as any)._iter ?? -1)) {
          deps[bodyId] = {
            output,
            previous_iteration: deps[bodyId]
              ? { output: deps[bodyId].output }
              : undefined,
            history: [],
          };
        }
      }
    }

    // Fallback: single-body legacy format (bodyIds empty)
    if (bodyIds.length === 0) {
      const iterNodeId = `${loopNode.nodeIdInDag}/body`;
      const bodyNodes = allNodes
        .filter((n) => n.nodeIdInDag === iterNodeId && n.status === "done")
        .sort((a, b) => b.iteration - a.iteration);

      if (bodyNodes.length > 0) {
        const latestBody = bodyNodes[0]!;
        const latestOutput = await this.readArtifactContent(latestBody.outputArtifactId);
        const prevBody = bodyNodes[1];
        const prevOutput = prevBody
          ? await this.readArtifactContent(prevBody.outputArtifactId)
          : undefined;

        deps["body"] = {
          output: latestOutput,
          previous_iteration: prevOutput !== undefined ? { output: prevOutput } : undefined,
        };
      }
    }

    // Build history array in iteration order
    const maxIter = Math.max(0, ...historyByIteration.keys());
    const history: Array<Record<string, { output?: unknown }>> = [];
    for (let i = 1; i <= maxIter; i++) {
      history.push(historyByIteration.get(i) ?? {});
    }
    // Attach to each body dep
    for (const bodyId of bodyIds) {
      if (deps[bodyId]) {
        (deps[bodyId] as any).history = history;
      }
    }

    const inputs = (run.inputs ?? {}) as Record<string, unknown>;
    return {
      inputs,
      deps,
      iteration: loopNode.iteration,
    };
  }

  // ─── G12: Frozen Fanout Items ───────────────────────────────────────────

  /**
   * G12: Get frozen fanout items for a parallel_over node.
   *
   * On FIRST expansion: evaluate items_from as an expression against real dep
   * artifact content, store the result as a "fanout.frozen" event, return items.
   *
   * On SUBSEQUENT ticks: retrieve the frozen list from the event store.
   *
   * Returns null if items_from fails to resolve an array.
   */
  private async getFrozenFanoutItems(
    runId: string,
    node: NodeRow,
    allNodes: NodeRow[],
    nodeMap: Map<string, NodeRow[]>,
    dagNode: V3NodeDag | undefined,
    dag: V3NodeDag[],
    run: RunRow,
  ): Promise<unknown[] | null> {
    // Check if we already have a frozen item set for this node
    const existingFreezeEvent = await this.db
      .select()
      .from(v3Events)
      .where(
        and(
          eq(v3Events.runId, runId),
          eq(v3Events.kind, "fanout.frozen"),
        ),
      );

    for (const ev of existingFreezeEvent) {
      const payload = ev.payload as Record<string, unknown> | null;
      if (payload?.nodeId === node.nodeIdInDag && Array.isArray(payload?.items)) {
        return payload.items as unknown[];
      }
    }

    // First expansion: evaluate items_from expression
    const itemsFromExpr = dagNode?.items_from as string | undefined;

    if (!itemsFromExpr) {
      // No items_from: try to parse body as literal array (legacy JSON)
      const bodyRaw = dagNode?.body;
      if (typeof bodyRaw === "string") {
        try {
          const parsed = JSON.parse(bodyRaw);
          if (Array.isArray(parsed)) {
            await this.freezeFanoutItems(runId, node.nodeIdInDag, parsed);
            return parsed;
          }
        } catch {
          // Not JSON
        }
      }
      await this.freezeFanoutItems(runId, node.nodeIdInDag, []);
      return [];
    }

    // Try JSON.parse shortcut first (literal array string)
    try {
      const parsed = JSON.parse(itemsFromExpr);
      if (Array.isArray(parsed)) {
        await this.freezeFanoutItems(runId, node.nodeIdInDag, parsed);
        return parsed;
      }
    } catch {
      // Not a literal JSON array — evaluate as expression
    }

    // G12: Evaluate as EXPRESSION against REAL dep artifact content
    try {
      const ctx = await this.buildGuardContext(run, node, allNodes, dag);
      const result = evaluateExpression(itemsFromExpr, ctx);
      if (Array.isArray(result)) {
        await this.freezeFanoutItems(runId, node.nodeIdInDag, result);
        return result;
      }
      // Not an array — fail
      return null;
    } catch {
      return null;
    }
  }

  /** Persist the frozen item set as a "fanout.frozen" event. */
  private async freezeFanoutItems(
    runId: string,
    nodeIdInDag: string,
    items: unknown[],
  ): Promise<void> {
    await this.writeEvent(runId, "fanout.frozen", {
      nodeId: nodeIdInDag,
      items,
      frozenAt: new Date().toISOString(),
    });
  }

  // ─── G12: Artifact Content Resolution ──────────────────────────────────

  /**
   * Read the content of an artifact by id.
   * Returns object_content if available, otherwise text_content.
   * Returns undefined if artifact id is null or artifact not found.
   */
  private async readArtifactContent(
    artifactId: string | null | undefined,
  ): Promise<unknown> {
    if (!artifactId) return undefined;

    const [artifact] = await this.db
      .select()
      .from(v3Artifacts)
      .where(eq(v3Artifacts.id, artifactId));

    if (!artifact) return undefined;

    return artifact.objectContent ?? artifact.textContent ?? undefined;
  }

  // ─── G18: Pool Capacity ─────────────────────────────────────────────────

  /**
   * G18: Count all currently running spawns across ALL runs to determine
   * global pool utilization.
   */
  private async countGlobalRunning(): Promise<number> {
    const result = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(v3Nodes)
      .where(eq(v3Nodes.status, "running"));

    return Number(result[0]?.count ?? 0);
  }

  // ─── G19: Error Classification ──────────────────────────────────────────

  /** G19: Classify an error into a retryable category. */
  private classifyError(err: unknown): string {
    const message = err instanceof Error
      ? `${err.name}: ${err.message}`
      : String(err);
    const lower = message.toLowerCase();

    // Schema violation — retryable with corrective prompt per design §12
    if (
      lower.includes("schema-violation") ||
      lower.includes("schema validation") ||
      lower.includes("output_schema")
    ) {
      return "schema-violation";
    }

    // Permanent errors — do not retry
    if (
      lower.includes("invalid schema") ||
      lower.includes("agent not found") ||
      lower.includes("engine not configured") ||
      lower.includes("render failure") ||
      lower.includes("permanent")
    ) {
      return "permanent";
    }

    // Transient — API/network/OOM/rate-limit
    const transientIndicators = [
      "etimedout", "econnreset", "econnrefused", "enetunreach",
      "eai_fail", "eai_again", "network", "timeout", "rate.limit",
      "rate limit", "too many requests", "429", "502", "503", "504",
      "oom", "out of memory", "context deadline exceeded",
      "canceled", "aborted", "transient",
    ];
    for (const ind of transientIndicators) {
      if (lower.includes(ind)) return "transient";
    }

    // Default: transient — retry once for unknown failures
    return "transient";
  }

  // ─── Expression Context ─────────────────────────────────────────────────

  /**
   * @deprecated Use buildLoopExpressionContext for loop nodes.
   * Kept for backward compatibility.
   */
  private buildExpressionContext(
    loopNode: NodeRow,
    allNodes: NodeRow[],
    nodeMap: Map<string, NodeRow[]>,
    dag: V3NodeDag[],
    bodyId: string,
  ): ExpressionContext {
    const depIds = this.getNodeDeps(loopNode, dag);

    const deps: Record<
      string,
      {
        output?: unknown;
        previous_iteration?: { output?: unknown };
        history?: Array<Record<string, { output?: unknown }>>;
      }
    > = {};

    for (const depId of depIds) {
      const depRows = nodeMap.get(depId);
      if (depRows) {
        const latest = depRows
          .filter((n) => RESOLVED_STATUSES.has(n.status))
          .sort((a, b) => b.iteration - a.iteration)[0];

        if (latest) {
          deps[depId] = {
            // NOTE: artifact content resolved at dispatch layer; null here
            output: latest.outputArtifactId ? null : undefined,
          };
        }
      }
    }

    // Add loop body previous iteration output
    const bodyNodes = allNodes.filter(
      (n) => n.nodeIdInDag === `${loopNode.nodeIdInDag}/body` && n.status === "done",
    );
    const latestBody = bodyNodes.sort((a, b) => b.iteration - a.iteration)[0];

    if (latestBody) {
      deps[bodyId] = {
        previous_iteration: {
          output: latestBody.outputArtifactId ? null : undefined,
        },
        output: latestBody.outputArtifactId ? null : undefined,
      };
    }

    return {
      inputs: {}, // Would come from v3_runs.inputs in full impl
      deps,
      iteration: loopNode.iteration,
    };
  }

  // ─── DAG Helpers ────────────────────────────────────────────────────────

  private loadDag(run: RunRow, nodes: NodeRow[]): V3NodeDag[] {
    // Try to parse DAG from run.dag (may be object or JSON string)
    const dagRaw = run.dag;
    if (dagRaw && typeof dagRaw === "object" && "nodes" in dagRaw) {
      return dagRaw.nodes as V3NodeDag[];
    }
    if (typeof dagRaw === "string") {
      try {
        const parsed = JSON.parse(dagRaw);
        if (parsed?.nodes && Array.isArray(parsed.nodes)) {
          return parsed.nodes as V3NodeDag[];
        }
      } catch {
        // Fall through to node-based reconstruction
      }
    }

    // Fallback: reconstruct minimal DAG from node rows
    return nodes.map((n) => ({
      id: n.nodeIdInDag,
      type: n.type as V3NodeDag["type"],
      deps: [],
    }));
  }

  private getNodeDeps(node: NodeRow, dag: V3NodeDag[]): string[] {
    const dagNode = dag.find((d) => d.id === node.nodeIdInDag);
    if (dagNode?.deps && Array.isArray(dagNode.deps)) {
      return dagNode.deps;
    }

    // Special: fanout children depend on the parallel_over node itself
    if (node.nodeIdInDag.includes(":[") && node.nodeIdInDag.includes("]")) {
      const parentId = node.nodeIdInDag.split(":[")[0]!;
      return [parentId];
    }

    // Special: loop body depends on the loop node OR the previous body step
    // Pattern: loopId/bodyNodeId — depends on loop node
    if (node.nodeIdInDag.includes("/")) {
      const loopId = node.nodeIdInDag.split("/")[0]!;
      // If fanoutIndex > 0, this body step depends on the previous step in the same iteration
      if (node.fanoutIndex > 0) {
        // Find the body node id (the part after the loop id)
        const dagNode = dag.find((d) => d.id === loopId);
        if (dagNode) {
          const bodyRaw = dagNode.body;
          const bodyIds: string[] = Array.isArray(bodyRaw)
            ? (bodyRaw as string[])
            : typeof bodyRaw === "string"
              ? [bodyRaw]
              : [];
          const prevBodyId = bodyIds[node.fanoutIndex - 1];
          if (prevBodyId) {
            return [`${loopId}/${prevBodyId}`];
          }
        }
      }
      return [loopId];
    }

    return [];
  }

  private buildNodeMap(nodes: NodeRow[]): Map<string, NodeRow[]> {
    const map = new Map<string, NodeRow[]>();
    for (const node of nodes) {
      const existing = map.get(node.nodeIdInDag) ?? [];
      existing.push(node);
      map.set(node.nodeIdInDag, existing);
    }
    return map;
  }

  private findLatestNode(
    nodeMap: Map<string, NodeRow[]>,
    nodeId: string,
  ): NodeRow | undefined {
    const rows = nodeMap.get(nodeId);
    if (!rows || rows.length === 0) {
      return undefined;
    }
    // Return highest iteration
    return rows.sort((a, b) => b.iteration - a.iteration)[0];
  }

  /**
   * Walk upstream deps to check if any ancestor is in the failed set.
   */
  private hasFailedAncestor(
    nodeId: string,
    dag: V3NodeDag[],
    failedIds: Set<string>,
    visited: Set<string>,
  ): boolean {
    if (visited.has(nodeId)) return false;
    visited.add(nodeId);

    const dagNode = dag.find((d) => d.id === nodeId);
    if (!dagNode) return false;

    for (const dep of dagNode.deps ?? []) {
      if (failedIds.has(dep)) return true;
      if (this.hasFailedAncestor(dep, dag, failedIds, visited)) return true;
    }

    return false;
  }

  // ─── Run Control ────────────────────────────────────────────────────────

  /** Pause a running run. */
  public async pause(runId: string): Promise<void> {
    await this.db
      .update(v3Runs)
      .set({ status: "paused" })
      .where(and(eq(v3Runs.id, runId), eq(v3Runs.status, "running")));

    await this.writeEvent(runId, "run.paused", {});
  }

  /** Resume a paused run. */
  public async resume(runId: string): Promise<void> {
    await this.db
      .update(v3Runs)
      .set({ status: "running" })
      .where(and(eq(v3Runs.id, runId), eq(v3Runs.status, "paused")));

    await this.writeEvent(runId, "run.resumed", {});
  }

  /** Cancel a run: skip all pending/ready/running nodes, mark run cancelled. */
  public async cancel(runId: string): Promise<void> {
    // Skip non-terminal nodes
    await this.db
      .update(v3Nodes)
      .set({ status: "skipped", error: "Run cancelled" })
      .where(
        and(
          eq(v3Nodes.runId, runId),
          inArray(v3Nodes.status, ["pending", "ready", "running"]),
        ),
      );

    await this.db
      .update(v3Runs)
      .set({
        status: "cancelled",
        completedAt: new Date(),
      })
      .where(eq(v3Runs.id, runId));

    await this.writeEvent(runId, "run.cancelled", {});
  }

  // ─── Internal Helpers ───────────────────────────────────────────────────

  /**
   * G20: Finalize a run, honoring on_failure:"continue" for failed nodes.
   * A run can only be "done" if no blocking-failure nodes exist.
   */
  private async finalizeRun(
    runId: string,
    status: "done" | "failed" | "cancelled",
    nodes: NodeRow[],
  ): Promise<void> {
    // Only transition if not already terminal
    const current = await this.db
      .select({ status: v3Runs.status, tags: v3Runs.tags })
      .from(v3Runs)
      .where(eq(v3Runs.id, runId))
      .limit(1);

    if (current.length === 0) return;

    const currentStatus = current[0]!.status;
    if (
      currentStatus === "done" ||
      currentStatus === "failed" ||
      currentStatus === "cancelled"
    ) {
      return; // Already terminal
    }

    await this.db
      .update(v3Runs)
      .set({
        status,
        completedAt: new Date(),
      })
      .where(eq(v3Runs.id, runId));

    // Best-effort wake: if this run was launched by the orchestrator (an
    // orchestrationSessionId is carried in tags), record a durable
    // "review + commit now" event so the orchestrator session can auto-review on
    // terminal WITHOUT a human re-prompt. This is NOT a §19 violation: it writes
    // an internal durable event the in-app / Claude Code orchestrator runner
    // POLLS — there is no server-initiated push to an external MCP host. Wrapped
    // so a wake failure can never block reconcile.
    try {
      await this.maybeWakeOrchestrator(runId, status, current[0]!.tags);
    } catch {
      // Advisory only — never block run finalization.
    }
  }

  /**
   * On run-terminal, wake whoever is monitoring this run so the result is
   * reviewed + committed WITHOUT a human re-prompt. Two channels, both fed from
   * the run's `tags`:
   *
   *  1. `tags.brainThreadId` (set by brain-send) — directly RESUME that brain
   *     thread (a new `claude --resume` turn) with a "your run is terminal,
   *     review + commit" message. This closes the single-turn-long-poll gap: a
   *     brain that ends its turn while the run is still in flight is auto-woken
   *     when the run finishes, polls to done, reviews, and commits.
   *  2. `tags.orchestrationSessionId` (legacy) — write a durable
   *     `run.terminal-review-requested` event the in-app orchestrator runner
   *     POLLS (no server→external-host push; not a §19 violation).
   *
   * Idempotent: a `run.terminal-review-requested` event is written once and used
   * as the guard so a re-reconcile of the same terminal run never double-wakes.
   * Best-effort: any failure here is swallowed by the caller and never blocks
   * run finalization.
   */
  private async maybeWakeOrchestrator(
    runId: string,
    status: "done" | "failed" | "cancelled",
    tags: unknown,
  ): Promise<void> {
    const t =
      tags && typeof tags === "object"
        ? (tags as Record<string, unknown>)
        : {};
    const sessionId = t["orchestrationSessionId"];
    const brainThreadId = t["brainThreadId"];
    const haveSession = typeof sessionId === "string" && sessionId;
    const haveThread = typeof brainThreadId === "string" && brainThreadId;
    if (!haveSession && !haveThread) return;

    // Idempotency guard: only wake once per terminal run.
    const already = await this.db
      .select({ id: v3Events.id })
      .from(v3Events)
      .where(
        and(
          eq(v3Events.runId, runId),
          eq(v3Events.kind, "run.terminal-review-requested"),
        ),
      )
      .limit(1);
    if (already.length > 0) return;

    const message =
      `Your orchestrated run \`${runId}\` reached a terminal state (${status}). ` +
      `Resume now: poll mcp__orchestrator__runState / v3RunNodes until every node ` +
      `is terminal, then REVIEW with runSummary + nodeSummary (full_diff). If the ` +
      `change passes, DELIVER by calling mcp__orchestrator__workspaceCommit ` +
      `(host-native; NOT workspaceCommitPush, which needs a VM this deployment ` +
      `lacks) with createMr:true to commit the feature branch and open the PR, ` +
      `then report the run id and the PR url. Do not start a new run.`;

    // Durable event (channel 2 + idempotency marker).
    await this.writeEvent(runId, "run.terminal-review-requested", {
      orchestrationSessionId: haveSession ? sessionId : null,
      brainThreadId: haveThread ? brainThreadId : null,
      status,
      message,
    });

    // ── LEVEL-1 SLOT RELEASE (critical) ───────────────────────────────────────
    // A brain_task occupies a concurrency slot from admission until its bound
    // run reaches terminal. This is THE release anchor: keyed on the RUN going
    // terminal (not the thread's status, which flips to 'running' on every
    // wake). Mark the thread's running brain_task terminal and pull the next
    // queued task into the freed slot. Runs once per terminal run (the
    // run.terminal-review-requested event above is the idempotency guard).
    // Best-effort + dynamically imported so the engine keeps no static brain dep.
    if (haveThread) {
      try {
        const { releaseBrainTaskForThread } = await import(
          "../queue/brain-admit.js"
        );
        await releaseBrainTaskForThread(brainThreadId as string, status);
      } catch {
        // Advisory — the brain reaper releases the slot as a backstop.
      }
    }

    // Channel 1: directly resume the brain thread (auto-wake). Dynamically
    // imported so the engine module has no static dependency on the brain layer.
    if (haveThread) {
      try {
        const [thread] = await this.db
          .select({
            id: brainThreads.id,
            ownerEmail: brainThreads.ownerEmail,
            orgId: brainThreads.orgId,
            status: brainThreads.status,
          })
          .from(brainThreads)
          .where(eq(brainThreads.id, brainThreadId as string))
          .limit(1);
        // Only resume a thread that is NOT already mid-turn (avoid stacking
        // turns on a brain that is still actively polling this run).
        if (thread && thread.status !== "running") {
          const { startBrainTurn } = await import("../brain/brain-session.js");
          await startBrainTurn({
            threadId: thread.id,
            ownerEmail: thread.ownerEmail,
            orgId: thread.orgId ?? null,
            message,
          });
        }
      } catch {
        // Best-effort: the durable event above still lets a manual/poll resume.
      }
    }
  }

  /**
   * Event-driven NODE-level wake (requirement 1). When a node JUST became
   * terminal (done/failed/skipped) and the run itself is NOT yet terminal, wake
   * the monitoring brain (tags.brainThreadId) for a SHORT check-in turn: it
   * polls once, sees the node resolved, and decides whether to intervene or keep
   * waiting — instead of busy-polling in-place between waves.
   *
   * Idempotency: a per-node `node.brain-wake-requested` marker event is written
   * once per (run, node). Re-ticks of the same resolved node never re-wake.
   *
   * Overlap guard: the brain is only woken when its thread is NOT mid-turn
   * (status != 'running'). When it IS mid-turn we STILL write the marker (so we
   * don't spam wakes later) — the in-flight turn will observe the node anyway,
   * and the periodic timer is the backstop if it doesn't.
   *
   * Coordination with the timer: a successful wake stamps brain_threads
   * .last_wake_at (via startBrainTurn's turn-start stamp), so an event resets
   * the periodic drift-check timer and the scheduler won't double-fire.
   */
  private async maybeWakeOrchestratorOnNode(
    runId: string,
    tags: unknown,
    nodes: NodeRow[],
  ): Promise<void> {
    const t =
      tags && typeof tags === "object"
        ? (tags as Record<string, unknown>)
        : {};
    const brainThreadId = t["brainThreadId"];
    if (typeof brainThreadId !== "string" || !brainThreadId) return;

    // Newly-terminal nodes that have not yet had a wake marker written.
    const terminalNodes = nodes.filter((n) => TERMINAL_STATUSES.has(n.status));
    if (terminalNodes.length === 0) return;

    // Load existing per-node wake markers for this run (one query).
    const markerEvents = await this.db
      .select({ payload: v3Events.payload })
      .from(v3Events)
      .where(
        and(
          eq(v3Events.runId, runId),
          eq(v3Events.kind, "node.brain-wake-requested"),
        ),
      );
    const alreadyMarked = new Set<string>();
    for (const ev of markerEvents) {
      const p = ev.payload as Record<string, unknown> | null;
      const key = p?.nodeKey;
      if (typeof key === "string") alreadyMarked.add(key);
    }

    // A node instance is keyed by id (covers loop iterations / fanout children).
    const fresh = terminalNodes.filter((n) => !alreadyMarked.has(n.id));
    if (fresh.length === 0) return;

    // Write a marker per freshly-terminal node so we never re-wake on it.
    for (const n of fresh) {
      await this.writeEvent(runId, "node.brain-wake-requested", {
        nodeKey: n.id,
        nodeId: n.nodeIdInDag,
        status: n.status,
      });
    }

    // Wake the brain ONCE per tick for the batch of newly-terminal nodes, but
    // only if it is not mid-turn. The marker above guarantees one-wake-per-node
    // regardless of whether we actually resume here.
    try {
      const [thread] = await this.db
        .select({
          id: brainThreads.id,
          ownerEmail: brainThreads.ownerEmail,
          orgId: brainThreads.orgId,
          status: brainThreads.status,
        })
        .from(brainThreads)
        .where(eq(brainThreads.id, brainThreadId))
        .limit(1);
      if (!thread || thread.status === "running") return;

      const nodeList = fresh
        .map((n) => `${n.nodeIdInDag} → ${n.status}`)
        .join(", ");
      const message =
        `节点事件:你编排的 run \`${runId}\` 有节点完成(${nodeList})。` +
        `快速检查一次 runState/v3RunNodes:正常推进→简短确认并结束回合(继续等待);` +
        `有节点失败/跑偏→用 workflowPatch/nodeRetry/runCancel 介入。不要原地轮询,检查完立即结束。`;

      const { startBrainTurn } = await import("../brain/brain-session.js");
      await startBrainTurn({
        threadId: thread.id,
        ownerEmail: thread.ownerEmail,
        orgId: thread.orgId ?? null,
        message,
      });
    } catch {
      // Best-effort — the periodic timer is the backstop.
    }
  }

  /**
   * Write a v3_event with auto-incrementing seq_num.
   * seq_num is managed by querying the current max and incrementing.
   */
  private async writeEvent(
    runId: string,
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    // Get next seq_num via drizzle aggregate
    const maxResult = await this.db
      .select({
        nextSeq: sql<number>`COALESCE(MAX(${v3Events.seqNum}), 0) + 1`,
      })
      .from(v3Events)
      .where(eq(v3Events.runId, runId));

    const nextSeq = maxResult[0]?.nextSeq ?? 1;

    const event: EventInsert = {
      id: uid(),
      runId,
      spawnId: null,
      kind,
      payload,
      seqNum: nextSeq,
      ts: new Date(),
      ownerEmail: "local@localhost",
      orgId: null,
    };

    await this.db.insert(v3Events).values(event);
  }

  private toBool(value: unknown): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") return value !== "";
    return value != null;
  }
}
