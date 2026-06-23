// V3 Event-Driven Reconciler (DESIGN §9, IMPLEMENTATION §A)
//
// Replaces V2's one-shot scheduler with an event-driven tick loop.
// Each tick acquires a PG advisory lock, reads current state, dispatches
// ready nodes, cascades failures, and writes events.  Pause / resume /
// cancel are first-class operations.

import { eq, and, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { v3Runs, v3Nodes, v3Events } from "../db/v3-schema.js";
import { v3DbExec } from "../db/v3.js";
import type { InferSelectModel, InferInsertModel } from "drizzle-orm";
import { evaluateExpression } from "./expression-parser.js";
import type { ExpressionContext } from "./expression-parser.js";

// ── Types ────────────────────────────────────────────────────────────────────

type RunRow = InferSelectModel<typeof v3Runs>;
type NodeRow = InferSelectModel<typeof v3Nodes>;
type EventInsert = InferInsertModel<typeof v3Events>;

export interface V3NodeDag {
  id: string;
  type: "agent" | "parallel_over" | "loop" | "human_gate";
  deps?: string[];
  body?: string;
  items_from?: string;
  until?: string;
  maxIterations?: number;
  [key: string]: unknown;
}

export interface V3Dispatcher {
  /**
   * Spawn an agent node.  Returns the spawn id written to v3_spawns.
   */
  spawn(node: NodeRow, runId: string): Promise<string>;
}

// Terminal node statuses (no further work possible)
const TERMINAL_STATUSES = new Set(["done", "failed", "skipped"]);
const RESOLVED_STATUSES = new Set(["done", "skipped"]);

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compute a 32-bit signed integer lock id for the given runId.
 *
 * Postgres advisory locks take a bigint.  The design doc specifies
 * `hashtext(runId)` — we delegate to Postgres' hashtext() for the lock
 * acquisition query and use the raw runId string parameterised via the
 * raw SQL call.  This helper only exists for the explicit unlock call
 * (same expression, same value).
 */
function buildLockExpr(runId: string): string {
  // Use hashtext() in PG so lock/unlock use identical expression.
  // Value is passed via the raw SQL string — runId is a caller-controlled
  // opaque uuid, safe to embed (no user input).
  return `hashtext('${runId.replace(/'/g, "''")}')`;
}

/** Generate a unique id for DB rows. */
function uid(): string {
  return crypto.randomUUID();
}

// ── Reconciler ───────────────────────────────────────────────────────────────

export class V3Reconciler {
  private readonly db: PostgresJsDatabase;
  private readonly dispatcher: V3Dispatcher;

  constructor(db: PostgresJsDatabase, dispatcher: V3Dispatcher) {
    this.db = db;
    this.dispatcher = dispatcher;
  }

  // ─── tick ───────────────────────────────────────────────────────────────

  /**
   * Single reconciler tick for a given run.
   *
   * Steps:
   *  0. Acquire PG advisory lock (skip if another tick owns it)
   *  1. Read run — skip if not running
   *  2. Read all nodes
   *  3. Cascade-skip downstream of any failed node → mark run failed
   *  4. Find ready nodes (all deps resolved/skipped)
   *  5. Dispatch ready nodes by type
   *  6. Check run completion
   *  7. All mutations are recorded as v3_events
   */
  public async tick(runId: string): Promise<void> {
    const lockExpr = buildLockExpr(runId);

    // 0. Advisory lock — non-blocking; skip if another tick holds it.
    const lockResult = await v3DbExec(
      `SELECT pg_try_advisory_lock(${lockExpr}) AS locked`,
    );
    const locked = (lockResult.rows[0]?.locked ?? false) as boolean;

    if (!locked) {
      return; // Another tick in progress — bail silently
    }

    try {
      await this._tickLocked(runId);
    } finally {
      // Unlock in finally — connection drop auto-releases anyway, but be explicit.
      await v3DbExec(`SELECT pg_advisory_unlock(${lockExpr})`);
    }
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
      await this.finalizeRun(runId, "done");
      return;
    }

    // Build adjacency helpers (in-memory from DAG stored on run/nodes)
    const dag = this.loadDag(run, nodes);

    // 3. Detect failed nodes → cascade skip all downstream
    const failedNodes = nodes.filter((n) => n.status === "failed");
    if (failedNodes.length > 0) {
      // Cascade: skip all pending nodes whose upstream has a failed ancestor
      const failedIds = new Set(failedNodes.map((n) => n.nodeIdInDag));

      // Find all pending nodes that are downstream of a failed node
      const toSkip = nodes.filter(
        (n) =>
          n.status === "pending" &&
          this.hasFailedAncestor(n.nodeIdInDag, dag, failedIds, new Set()),
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

        for (const fn of failedNodes) {
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

      await this.finalizeRun(runId, "failed");
      await this.writeEvent(runId, "run.failed", {});
      return;
    }

    // 4. Find ready nodes (all deps resolved or skipped)
    const nodeMap = this.buildNodeMap(nodes);

    const readyNodes: NodeRow[] = [];
    for (const node of nodes) {
      if (TERMINAL_STATUSES.has(node.status)) {
        continue; // Already terminal
      }
      if (node.status === "awaiting-approval") {
        continue; // Waiting for human
      }
      if (node.status === "running") {
        continue; // Still executing
      }

      const depIds = this.getNodeDeps(node, dag);
      const depsSatisfied = depIds.every((depId) => {
        const depNode = this.findLatestNode(nodeMap, depId);
        return depNode !== undefined && RESOLVED_STATUSES.has(depNode.status);
      });

      // If no deps, the node is immediately ready
      if (depsSatisfied) {
        readyNodes.push(node);
      }
    }

    // 5. Dispatch ready nodes
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];

    for (const node of readyNodes) {
      const result = await this.dispatchNode(runId, node, nodes, nodeMap, dag);
      events.push(...result);
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

    const hasFailed = updatedNodes.some((n) => n.status === "failed");
    const allDoneOrSkipped = updatedNodes.every((n) =>
      RESOLVED_STATUSES.has(n.status),
    );
    const allTerminalOrWaiting = updatedNodes.every((n) =>
      TERMINAL_STATUSES.has(n.status) || n.status === "awaiting-approval",
    );
    const anyWaiting = updatedNodes.some((n) => n.status === "awaiting-approval");

    if (hasFailed) {
      await this.finalizeRun(runId, "failed");
      await this.writeEvent(runId, "run.failed", {});
    } else if (allDoneOrSkipped) {
      await this.finalizeRun(runId, "done");
      await this.writeEvent(runId, "run.completed", {});
    } else if (allTerminalOrWaiting && !anyWaiting) {
      // All resolved (should be caught by allDoneOrSkipped, but safe guard)
      await this.finalizeRun(runId, "done");
      await this.writeEvent(runId, "run.completed", {});
    }
    // If some nodes are awaiting-approval, run stays "running" —
    // resume() after human_gate resolution will re-tick.
  }

  // ─── Node Dispatch ──────────────────────────────────────────────────────

  /**
   * Dispatch a single ready node based on its type.
   * Returns events to be written.
   */
  private async dispatchNode(
    runId: string,
    node: NodeRow,
    allNodes: NodeRow[],
    nodeMap: Map<string, NodeRow[]>,
    dag: V3NodeDag[],
  ): Promise<Array<{ kind: string; payload: Record<string, unknown> }>> {
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];

    switch (node.type) {
      case "agent": {
        await this.db
          .update(v3Nodes)
          .set({ status: "running", startedAt: new Date() })
          .where(eq(v3Nodes.id, node.id));

        const spawnId = await this.dispatcher.spawn(node, runId);

        await this.db
          .update(v3Nodes)
          .set({ currentSpawnId: spawnId })
          .where(eq(v3Nodes.id, node.id));

        events.push({
          kind: "node.dispatched",
          payload: { nodeId: node.nodeIdInDag, spawnId },
        });
        break;
      }

      case "parallel_over": {
        const dagNode = dag.find((d) => d.id === node.nodeIdInDag);
        const bodyId = (dagNode?.body as string | undefined) ?? "";

        // Parse items for fanout
        const items = this.resolveFanoutItems(dagNode, allNodes, nodeMap);

        for (let i = 0; i < items.length; i++) {
          const childNodeId = `${node.nodeIdInDag}:[${i}]`;

          // Check if fanout child already exists (re-entrant tick safety)
          const existing = allNodes.find(
            (n) => n.nodeIdInDag === childNodeId && n.fanoutIndex === i,
          );
          if (existing) {
            continue;
          }

          // Fanout children are instances of the body node;
          // they depend on the parallel_over parent (handled by getNodeDeps)
          const childNode: Omit<NodeRow, "ownerEmail" | "orgId"> & {
            ownerEmail: string;
            orgId: null | string;
          } = {
            id: uid(),
            runId,
            nodeIdInDag: childNodeId,
            type: bodyId !== "" ? "agent" : "agent",
            status: "pending",
            iteration: 0,
            fanoutIndex: i,
            currentSpawnId: null,
            outputArtifactId: null,
            startedAt: null,
            completedAt: null,
            error: null,
            ownerEmail: "local@localhost",
            orgId: null,
          };

          await this.db.insert(v3Nodes).values(childNode as any);

          events.push({
            kind: "node.fanout-created",
            payload: {
              parentId: node.nodeIdInDag,
              childId: childNodeId,
              fanoutIndex: i,
              bodyId,
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
        break;
      }

      case "loop": {
        const dagNode = dag.find((d) => d.id === node.nodeIdInDag);
        const untilExpr = (dagNode?.until as string | undefined) ?? "false";
        const maxIter = (dagNode?.maxIterations as number | undefined) ?? 100;
        const bodyId = (dagNode?.body as string | undefined) ?? "";

        // Count completed body iterations
        const bodyNodes = allNodes.filter(
          (n) => n.nodeIdInDag === `${node.nodeIdInDag}/body`,
        );
        const currentIter = bodyNodes.length;

        // Evaluate until expression
        let shouldStop = false;
        try {
          const exprCtx = this.buildExpressionContext(
            node,
            allNodes,
            nodeMap,
            dag,
            bodyId,
          );

          const result = evaluateExpression(untilExpr, exprCtx);
          shouldStop = this.toBool(result);
        } catch {
          // Expression error — continue looping (body may not have output yet)
          shouldStop = false;
        }

        if (shouldStop || currentIter >= maxIter) {
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
              iterations: currentIter,
              maxIterations: maxIter,
            },
          });

          if (currentIter >= maxIter && !shouldStop) {
            events.push({
              kind: "loop.max-iterations-reached",
              payload: {
                nodeId: node.nodeIdInDag,
                iterations: currentIter,
              },
            });
          }
        } else {
          // Create new iteration body node
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
            iteration: currentIter + 1,
            fanoutIndex: 0,
            currentSpawnId: null,
            outputArtifactId: null,
            startedAt: null,
            completedAt: null,
            error: null,
            ownerEmail: "local@localhost",
            orgId: null,
          };

          await this.db.insert(v3Nodes).values(iterNode as any);

          events.push({
            kind: "loop.iteration-created",
            payload: {
              loopId: node.nodeIdInDag,
              iteration: currentIter + 1,
              bodyId: iterNodeId,
            },
          });
        }
        break;
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
        break;
      }

      default:
        // Unknown type — skip
        break;
    }

    return events;
  }

  // ─── Expression Context ─────────────────────────────────────────────────

  /**
   * Build ExpressionContext for evaluating loop `until` expressions.
   * Data comes from previous iteration outputs via deps.
   */
  private buildExpressionContext(
    loopNode: NodeRow,
    allNodes: NodeRow[],
    nodeMap: Map<string, NodeRow[]>,
    dag: V3NodeDag[],
    bodyId: string,
  ): ExpressionContext {
    const dagNode = dag.find((d) => d.id === loopNode.nodeIdInDag);
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
            // Full artifact content resolved at dispatch layer
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

  // ─── Fanout Items ───────────────────────────────────────────────────────

  private resolveFanoutItems(
    dagNode: V3NodeDag | undefined,
    _allNodes: NodeRow[],
    _nodeMap: Map<string, NodeRow[]>,
  ): unknown[] {
    const itemsFrom = dagNode?.items_from as string | undefined;

    if (itemsFrom) {
      // items_from is a JSON array string or an expression — try direct parse first
      try {
        const parsed = JSON.parse(itemsFrom);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        // Not JSON — could be an expression to be evaluated later
        // For now return empty (deferred to interpolation layer)
      }
    }

    return [];
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
      const parentId = node.nodeIdInDag.split(":[")[0];
      return [parentId];
    }

    // Special: loop body depends on the loop node
    if (node.nodeIdInDag.endsWith("/body")) {
      const loopId = node.nodeIdInDag.replace(/\/body$/, "");
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

  private async finalizeRun(
    runId: string,
    status: "done" | "failed" | "cancelled",
  ): Promise<void> {
    // Only transition if not already terminal
    const current = await this.db
      .select({ status: v3Runs.status })
      .from(v3Runs)
      .where(eq(v3Runs.id, runId))
      .limit(1);

    if (current.length === 0) return;

    const currentStatus = current[0].status;
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
