// ===========================================================================
// DETERMINISTIC SCHEDULER (DESIGN §4.1 / §4.1a).
//
// DETERMINISM INVARIANT (DESIGN §0.2.1 / §1.7 — HARD):
//   This module makes NO scheduling decision based on Date.now(), Math.random()
//   or argless `new Date()`. Readiness, fanout width, branch selection, loop
//   continuation, ids, and artifact keys derive ONLY from the graph, persisted
//   NodeRun outputs, and explicit run inputs (RunConfig.seed). Wall-clock
//   timestamps (started_at/completed_at via nowIso()) are written for
//   OBSERVABILITY only and are never branched on. The echo executor's optional
//   delay makes concurrency visible in timestamps but does not change topology.
//
// The scheduler is pure orchestration: it owns the DAG, concurrency, journaling
// and advancement, and delegates the only side-effecting work (turning a
// resolved input into an output) to a pluggable NodeExecutor (DESIGN §1.1).
// ===========================================================================

import type { Node } from "../../shared/types.js";
import { nowIso } from "../../actions/_util.js";
import {
  buildGraphModel,
  enclosingFanout,
  inEdges,
  nearestUpstreamFanout,
  outEdges,
  type GraphModel,
} from "./graph-model.js";
import { evalCondition, type ConditionContext } from "./conditions.js";
import { readPath } from "./jsonpath.js";
import { nodeRunId } from "./ids.js";
import {
  getLoopAccumulator,
  putInputArtifact,
  putLoopAccumulator,
  putOutputArtifact,
  type Db,
} from "./store.js";
import * as store from "./store.js";
import type {
  NodeExecutionInput,
  NodeExecutor,
  NodeRunKey,
  NodeRunState,
  RunConfig,
} from "./types.js";
import { keyStr } from "./types.js";

/** Final run outcome the driver returns. */
export interface RunOutcome {
  runId: string;
  status: "done" | "failed" | "cancelled";
  tokensSpent: number;
  nodeRuns: NodeRunState[];
}

/** A logical fanout scope materialized at run time. */
interface FanoutScope {
  fanoutNodeId: string;
  items: unknown[];
  width: number;
}

export class Scheduler {
  private readonly cfg: RunConfig;
  private readonly db: Db;
  private readonly executor: NodeExecutor;
  private readonly g: GraphModel;

  private readonly runs = new Map<string, NodeRunState>();
  private readonly fanoutScopes = new Map<string, FanoutScope>();
  private readonly outputs = new Map<string, unknown>();

  private readonly inFlight = new Map<string, Promise<void>>();
  private running = 0;
  private cancelled = false;
  private readonly abort = new AbortController();
  private tokensSpent = 0;

  constructor(args: { cfg: RunConfig; db: Db; executor: NodeExecutor }) {
    this.cfg = args.cfg;
    this.db = args.db;
    this.executor = args.executor;
    this.g = buildGraphModel(args.cfg.graph);
  }

  cancel(): void {
    this.cancelled = true;
    this.abort.abort();
  }

  /** Drive the run to completion (or cancellation) and return the outcome. */
  async run(): Promise<RunOutcome> {
    // Seed every SINGLETON NodeRun (index 0) up front: top-level nodes and
    // parallel-container children participate in the normal DAG by edges. Only
    // two kinds are created later, scoped: fanout bodies (per item, on
    // expansion) and loop bodies (per iteration, in runLoop).
    for (const n of this.g.nodes) {
      if (enclosingFanout(this.g, n.id) != null) continue; // fanout body → on expand
      if (this.isLoopBody(n.id)) continue; // loop body → per iteration
      await this.ensureRun(n, { nodeId: n.id, iteration: 0, fanoutIndex: 0 }, false);
    }

    return this.drive();
  }

  /**
   * Resume a partially-completed run from its journal (DESIGN §1.7). Two passes
   * (per IMPLEMENTATION §C): Pass 1 computes the dirty set — failed/pending
   * nodes, plus the ENTIRE fanout subtree of any dirty array-producer (no
   * partial reuse). Pass 2 replays every done-and-clean NodeRun WITHOUT calling
   * the executor (loads its output artifact, invoke count stays 0) and reruns
   * everything dirty live.
   */
  async resume(): Promise<RunOutcome> {
    const rows = await store.loadNodeRuns(this.db, this.cfg.runId);

    // Hydrate in-memory state from the journal.
    for (const r of rows) {
      const key: NodeRunKey = {
        nodeId: r.nodeId,
        iteration: r.iteration,
        fanoutIndex: r.fanoutIndex,
      };
      const node = this.g.byId.get(r.nodeId);
      if (!node) continue;
      const state: NodeRunState = {
        id: r.id,
        runId: r.runId,
        key,
        node,
        status: r.status,
        dynamic: r.dynamic === 1,
        inputRef: r.inputRef,
        outputRef: r.outputRef,
        error: r.error,
        attempts: r.attempts,
        tokensSpent: r.tokensSpent,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
      };
      this.runs.set(keyStr(key), state);
    }

    // Pass 1: dirty = failed | pending | ready (not yet completed) ...
    const dirty = new Set<string>();
    for (const s of this.runs.values()) {
      if (s.status === "failed" || s.status === "pending" || s.status === "ready") {
        dirty.add(keyStr(s.key));
      }
    }
    // ... plus the whole fanout subtree of any dirty array-producer (no partial
    // reuse), AND the transitive downstream of every dirty node (a divergent
    // tail re-runs; an upstream change invalidates everything it feeds).
    let grew = true;
    while (grew) {
      grew = false;
      for (const s of [...this.runs.values()]) {
        if (!dirty.has(keyStr(s.key))) continue;
        // Fanout subtree invalidation.
        for (const n of this.g.nodes) {
          if (n.type === "fanout" && n.itemsFrom === s.node.id) {
            for (const child of this.runs.values()) {
              if (enclosingFanout(this.g, child.node.id) === n.id) {
                if (!dirty.has(keyStr(child.key))) {
                  dirty.add(keyStr(child.key));
                  grew = true;
                }
              }
            }
            for (const fr of this.runs.values()) {
              if (fr.node.id === n.id && !dirty.has(keyStr(fr.key))) {
                dirty.add(keyStr(fr.key));
                grew = true;
              }
            }
          }
        }
        // Transitive downstream: every successor NodeRun of this node.
        for (const succId of this.g.out.get(s.node.id) ?? []) {
          for (const cand of this.runs.values()) {
            if (cand.node.id !== succId) continue;
            // Same iteration; index-preserved successors share the index.
            if (cand.key.iteration !== s.key.iteration) continue;
            if (!dirty.has(keyStr(cand.key))) {
              dirty.add(keyStr(cand.key));
              grew = true;
            }
          }
        }
      }
    }

    // Pass 2: replay clean-done outputs; reset dirty to pending for a live rerun.
    for (const s of this.runs.values()) {
      const ks = keyStr(s.key);
      if (s.status === "done" && !dirty.has(ks)) {
        // Replay: load the journaled output artifact (NO executor call).
        const val = s.outputRef
          ? await store.getArtifactValue(this.db, s.outputRef)
          : undefined;
        this.outputs.set(ks, val);
        // Re-seal a fanout scope from its replayed width.
        if (s.node.type === "fanout") {
          const w =
            val && typeof val === "object"
              ? Number((val as Record<string, unknown>).width ?? 0)
              : 0;
          const producerKey: NodeRunKey = {
            nodeId: s.node.itemsFrom ?? "",
            iteration: s.key.iteration,
            fanoutIndex: 0,
          };
          const raw = this.outputs.get(keyStr(producerKey));
          const items = Array.isArray(raw) ? raw.slice(0, w) : [];
          this.fanoutScopes.set(s.node.id, { fanoutNodeId: s.node.id, items, width: w });
        }
      } else if (dirty.has(ks)) {
        s.status = "pending";
        s.error = null;
        await store.updateNodeRun(this.db, s);
      }
    }

    // Seed any singleton nodes that were never created on the first run.
    for (const n of this.g.nodes) {
      if (enclosingFanout(this.g, n.id) != null) continue;
      if (this.isLoopBody(n.id)) continue;
      if (!this.runs.has(keyStr({ nodeId: n.id, iteration: 0, fanoutIndex: 0 }))) {
        await this.ensureRun(n, { nodeId: n.id, iteration: 0, fanoutIndex: 0 }, false);
      }
    }

    return this.drive();
  }

  /** The shared completion-driven event loop used by run() and resume(). */
  private async drive(): Promise<RunOutcome> {
    for (;;) {
      if (this.cancelled) break;
      await this.advance();
      if (this.inFlight.size === 0) break; // quiescent: nothing ready, none running
      await Promise.race(this.inFlight.values());
    }

    const anyFailed = [...this.runs.values()].some((r) => r.status === "failed");
    const status: RunOutcome["status"] = this.cancelled
      ? "cancelled"
      : anyFailed
        ? "failed"
        : "done";
    return {
      runId: this.cfg.runId,
      status,
      tokensSpent: this.tokensSpent,
      nodeRuns: [...this.runs.values()],
    };
  }

  /**
   * One advancement pass: compute readiness, settle every structural node that
   * is ready (synchronously, fully awaited), then launch ready leaf nodes
   * concurrently up to the cap. Repeats internally until no further structural
   * progress is possible without a leaf completing.
   */
  private async advance(): Promise<void> {
    let progressed = true;
    while (progressed && !this.cancelled) {
      progressed = false;
      // 1. Resolve readiness / skips for all pending nodes.
      await this.computeReadiness();
      // 2. Settle every ready STRUCTURAL node (these do not block on a slot).
      for (const state of this.readySnapshot()) {
        if (state.status !== "ready") continue;
        if (this.isStructural(state.node) || state.node.type === "human") {
          await this.settle(state);
          progressed = true;
        }
      }
      // 3. Launch ready LEAF nodes up to the concurrency cap.
      const launched = this.launchLeaves();
      if (launched > 0) progressed = true;
    }
  }

  private readySnapshot(): NodeRunState[] {
    return [...this.runs.values()]
      .filter((s) => s.status === "ready")
      .sort((a, b) => (keyStr(a.key) < keyStr(b.key) ? -1 : 1));
  }

  // ── NodeRun creation ──────────────────────────────────────────────────────

  private async ensureRun(
    node: Node,
    key: NodeRunKey,
    dynamic: boolean,
  ): Promise<NodeRunState> {
    const ks = keyStr(key);
    const existing = this.runs.get(ks);
    if (existing) return existing;
    if (this.runs.size >= this.cfg.caps.maxTotalNodes) {
      throw new Error(
        `Per-run node backstop (${this.cfg.caps.maxTotalNodes}) exceeded`,
      );
    }
    const state: NodeRunState = {
      id: nodeRunId(this.cfg.runId, key),
      runId: this.cfg.runId,
      key,
      node,
      status: "pending",
      dynamic,
      inputRef: null,
      outputRef: null,
      error: null,
      attempts: 0,
      tokensSpent: 0,
      startedAt: null,
      completedAt: null,
    };
    this.runs.set(ks, state);
    await store.insertNodeRun(this.db, state);
    return state;
  }

  // ── Readiness ─────────────────────────────────────────────────────────────

  private async computeReadiness(): Promise<void> {
    // Iterate to a fixpoint so a skip cascade settles before launching.
    let changed = true;
    while (changed) {
      changed = false;
      for (const state of [...this.runs.values()]) {
        if (state.status !== "pending") continue;
        const verdict = this.evaluate(state);
        if (verdict === "ready") {
          state.status = "ready";
          await store.updateNodeRun(this.db, state);
          changed = true;
        } else if (verdict === "skip") {
          await this.skip(state);
          changed = true;
        }
      }
    }
  }

  /**
   * Decide a pending node's fate: ready | skip | wait.
   *
   * Dead deps (skipped/failed) are FILTERED, never blocking — a convergence
   * point reached by a live path still runs (DESIGN §4.1a: ".filter(Boolean)").
   * A node is SKIPPED only when no live path remains: every inbound source is
   * dead, OR every inbound conditional (branch) edge's `when` is false (the
   * not-taken branch). This is the join-style filter generalized to ordinary
   * convergence so `end` after a branch still fires.
   */
  private evaluate(state: NodeRunState): "ready" | "skip" | "wait" {
    const node = state.node;

    if (node.type === "join") {
      return this.joinReady(state) ? "ready" : "wait";
    }

    const edges = inEdges(this.g, node.id);
    if (edges.length === 0) return "ready"; // a source node (start)

    // Partition inbound edges into live / dead / pending by their source.
    let live = 0;
    let dead = 0;
    let pending = 0;
    let branchEdges = 0;
    let branchSelected = 0;
    for (const e of edges) {
      const depKey = this.depKeyForEdge(state, e);
      const dep = this.runs.get(keyStr(depKey));
      const isBranchEdge =
        e.when != null && this.g.byId.get(e.from)?.type === "branch";
      if (isBranchEdge) branchEdges += 1;
      if (!dep) {
        pending += 1;
        continue;
      }
      if (dep.status === "skipped" || dep.status === "failed") {
        dead += 1;
        continue;
      }
      if (dep.status !== "done") {
        pending += 1;
        continue;
      }
      // dep is done. For a branch edge, it only counts as a live path if its
      // `when` selects this node (evaluated against the BRANCH's own deps).
      if (isBranchEdge) {
        const ctx = this.branchContext(
          e.from,
          state.key.iteration,
          this.depKeyForEdge(state, e).fanoutIndex,
        );
        if (evalCondition(e.when, ctx)) {
          branchSelected += 1;
          live += 1;
        } else {
          dead += 1; // the not-taken branch edge
        }
      } else {
        live += 1;
      }
    }

    // No live path can ever form: every inbound is dead → skip.
    if (live === 0 && pending === 0 && dead > 0) return "skip";
    // All inbound edges are branch edges and none selected this node → skip.
    if (branchEdges === edges.length && branchSelected === 0 && pending === 0) {
      return "skip";
    }
    // Still resolving some predecessors.
    if (pending > 0) return "wait";
    // Every settled inbound edge is decided; if at least one live path, ready.
    return live > 0 ? "ready" : "skip";
  }

  /** The dependency journal key a given inbound edge resolves to (item corr). */
  private depKeyForEdge(state: NodeRunState, e: { from: string }): NodeRunKey {
    const myFanout = enclosingFanout(this.g, state.node.id);
    const fromFanout = enclosingFanout(this.g, e.from);
    const indexPreserved = myFanout != null && fromFanout === myFanout;
    return {
      nodeId: e.from,
      iteration: state.key.iteration,
      fanoutIndex: indexPreserved ? state.key.fanoutIndex : 0,
    };
  }

  /**
   * Dependency journal keys with item correlation (DESIGN §4.1a): inside a
   * fanout scope an edge from a same-scope sibling is index-preserving
   * (A_i depends on B_i); an edge crossing the scope boundary resolves to the
   * singleton (index 0).
   */
  private resolveDeps(state: NodeRunState): { nodeId: string; key: NodeRunKey }[] {
    return inEdges(this.g, state.node.id).map((e) => ({
      nodeId: e.from,
      key: this.depKeyForEdge(state, e),
    }));
  }

  /**
   * Build the condition context for the SOURCE node of a branch edge — the
   * branch's own deps. A branch's `when` reads the values the branch saw
   * (e.g. `deps.gate[0].flag`), not the target's, so we resolve against the
   * branch node at the same iteration/fanoutIndex as the target.
   */
  private branchContext(
    branchId: string,
    iteration: number,
    fanoutIndex: number,
  ): ConditionContext {
    const branchState = this.runs.get(
      keyStr({ nodeId: branchId, iteration, fanoutIndex }),
    );
    const deps: Record<string, unknown> = {};
    const status: Record<string, string> = {};
    if (branchState) {
      for (const d of this.resolveDeps(branchState)) {
        const dep = this.runs.get(keyStr(d.key));
        if (dep) {
          deps[d.nodeId] = this.outputs.get(keyStr(d.key));
          status[d.nodeId] = dep.status;
        }
      }
    }
    return { deps, status };
  }

  // ── Join cardinality sealing (DESIGN §4.1a) ────────────────────────────────

  private joinReady(state: NodeRunState): boolean {
    const fanoutId = nearestUpstreamFanout(this.g, state.node.id);
    if (!fanoutId) {
      // Plain barrier over direct predecessors.
      return this.resolveDeps(state).every((d) => {
        const dep = this.runs.get(keyStr(d.key));
        return (
          dep != null &&
          (dep.status === "done" || dep.status === "failed" || dep.status === "skipped")
        );
      });
    }
    const scope = this.fanoutScopes.get(fanoutId);
    if (!scope) return false; // array not materialized → not sealed yet

    const feeders = inEdges(this.g, state.node.id).filter(
      (e) => enclosingFanout(this.g, e.from) === fanoutId,
    );
    if (feeders.length === 0) return false;
    // Wait until EVERY index has settled (done|failed|skipped) for every feeder.
    for (let i = 0; i < scope.width; i++) {
      for (const f of feeders) {
        const dep = this.runs.get(
          keyStr({ nodeId: f.from, iteration: state.key.iteration, fanoutIndex: i }),
        );
        if (!dep) return false;
        if (dep.status !== "done" && dep.status !== "failed" && dep.status !== "skipped") {
          return false;
        }
      }
    }
    return true;
  }

  // ── Skip propagation ───────────────────────────────────────────────────────

  private async skip(state: NodeRunState): Promise<void> {
    if (state.status === "skipped") return;
    state.status = "skipped";
    state.completedAt = nowIso();
    await store.updateNodeRun(this.db, state);
    // Eagerly create the exclusive downstream so a skipped branch terminates;
    // each downstream is re-evaluated in computeReadiness (it may still have a
    // live path via a join, in which case it is NOT skipped here).
    for (const e of outEdges(this.g, state.node.id)) {
      const child = this.g.byId.get(e.to);
      if (!child) continue;
      const sameScope =
        enclosingFanout(this.g, e.to) === enclosingFanout(this.g, state.node.id);
      const childKey: NodeRunKey = {
        nodeId: e.to,
        iteration: state.key.iteration,
        fanoutIndex: sameScope ? state.key.fanoutIndex : 0,
      };
      await this.ensureRun(child, childKey, false);
    }
  }

  // ── Settlement of ready nodes ──────────────────────────────────────────────

  /** True if `nodeId` is the body of some loop node (created per iteration). */
  private isLoopBody(nodeId: string): boolean {
    const container = this.g.containerOf.get(nodeId) ?? null;
    return container != null && this.g.byId.get(container)?.type === "loop";
  }

  private isStructural(node: Node): boolean {
    return (
      node.type === "start" ||
      node.type === "end" ||
      node.type === "parallel" ||
      node.type === "fanout" ||
      node.type === "branch" ||
      node.type === "join" ||
      node.type === "loop" ||
      node.type === "subworkflow"
    );
  }

  private async settle(state: NodeRunState): Promise<void> {
    const node = state.node;
    if (node.type === "human") {
      if (state.status !== "awaiting-approval") {
        state.status = "awaiting-approval";
        state.startedAt = nowIso();
        await store.updateNodeRun(this.db, state);
      }
      return;
    }
    state.startedAt = state.startedAt ?? nowIso();
    if (node.type === "fanout") {
      await this.expandFanout(state);
      return;
    }
    if (node.type === "loop") {
      await this.runLoop(state);
      return;
    }
    // start / end / parallel / branch / join / subworkflow: aggregate + done.
    const output = this.aggregateOutput(state);
    await this.markDone(state, output);
  }

  private aggregateOutput(state: NodeRunState): unknown {
    const node = state.node;
    if (node.type === "join") {
      const fanoutId = nearestUpstreamFanout(this.g, node.id);
      const scope = fanoutId ? this.fanoutScopes.get(fanoutId) : undefined;
      const merged: unknown[] = [];
      if (scope) {
        const feeders = inEdges(this.g, node.id).filter(
          (e) => enclosingFanout(this.g, e.from) === fanoutId,
        );
        for (let i = 0; i < scope.width; i++) {
          for (const f of feeders) {
            const dep = this.runs.get(
              keyStr({ nodeId: f.from, iteration: state.key.iteration, fanoutIndex: i }),
            );
            if (dep?.status === "done") merged.push(this.outputs.get(keyStr(dep.key)));
          }
        }
      }
      return { node: node.id, merged, degraded: merged.length === 0 };
    }
    const deps: Record<string, unknown> = {};
    for (const d of this.resolveDeps(state)) {
      deps[d.nodeId] = this.outputs.get(keyStr(d.key));
    }
    return { node: node.id, type: node.type, deps };
  }

  private async markDone(state: NodeRunState, output: unknown): Promise<void> {
    state.status = "done";
    state.completedAt = nowIso();
    this.outputs.set(keyStr(state.key), output);
    state.outputRef = await putOutputArtifact(this.db, this.cfg.runId, state, output);
    await store.updateNodeRun(this.db, state);
  }

  // ── Fanout expansion (DESIGN §1.5 / §4.1a) ─────────────────────────────────

  private async expandFanout(state: NodeRunState): Promise<void> {
    const node = state.node;
    if (this.fanoutScopes.has(node.id)) {
      await this.markDone(state, {
        node: node.id,
        width: this.fanoutScopes.get(node.id)!.width,
      });
      return;
    }
    const itemsFrom = node.itemsFrom;
    let arr: unknown[] = [];
    if (itemsFrom) {
      const producerKey: NodeRunKey = {
        nodeId: itemsFrom,
        iteration: state.key.iteration,
        fanoutIndex: 0,
      };
      const raw = this.outputs.get(keyStr(producerKey));
      if (Array.isArray(raw)) arr = raw;
    }
    const cap = node.maxConcurrency && node.maxConcurrency > 0 ? node.maxConcurrency : arr.length;
    const width = Math.min(arr.length, cap);
    const items = arr.slice(0, width);
    this.fanoutScopes.set(node.id, { fanoutNodeId: node.id, items, width });

    const childNodeIds = this.g.childrenOf.get(node.id) ?? [];
    for (let i = 0; i < width; i++) {
      for (const childId of childNodeIds) {
        const childNode = this.g.byId.get(childId);
        if (!childNode) continue;
        await this.ensureRun(
          childNode,
          { nodeId: childId, iteration: state.key.iteration, fanoutIndex: i },
          true,
        );
      }
    }
    await this.markDone(state, { node: node.id, width });
  }

  // ── Loop (loop-until-dry, DESIGN §1.5 / §3.2) ──────────────────────────────

  private async runLoop(state: NodeRunState): Promise<void> {
    const node = state.node;
    const bodyId = (node.children ?? [])[0];
    if (!bodyId || !this.g.byId.has(bodyId)) {
      await this.markDone(state, { node: node.id, iterations: 0, seen: [] });
      return;
    }
    const bodyNode = this.g.byId.get(bodyId)!;
    const maxIter = node.maxIterations ?? 1;
    const dryTarget = node.dryRounds && node.dryRounds > 0 ? node.dryRounds : 1;
    const dedupeKey = node.dedupeKey ?? "id";

    const seen = new Set<string>();
    let dryStreak = 0;
    let iteration = 0;
    for (; iteration < maxIter; iteration++) {
      if (this.cancelled) break;
      const key: NodeRunKey = { nodeId: bodyId, iteration, fanoutIndex: 0 };
      const bodyState = await this.ensureRun(bodyNode, key, iteration > 0);
      bodyState.status = "running";
      bodyState.startedAt = nowIso();
      bodyState.attempts += 1;
      await store.updateNodeRun(this.db, bodyState);
      const input: NodeExecutionInput = { node: bodyNode, deps: {}, fanoutIndex: 0, iteration };
      let output: unknown;
      try {
        const res = await this.executor.invoke(input, this.abort.signal);
        output = res.output;
        bodyState.tokensSpent = res.tokensSpent;
        this.tokensSpent += res.tokensSpent;
        bodyState.outputRef = await putOutputArtifact(this.db, this.cfg.runId, bodyState, output);
        bodyState.status = "done";
        bodyState.completedAt = nowIso();
        this.outputs.set(keyStr(key), output);
        await store.updateNodeRun(this.db, bodyState);
      } catch (err) {
        bodyState.status = "failed";
        bodyState.error = err instanceof Error ? err.message : String(err);
        bodyState.completedAt = nowIso();
        await store.updateNodeRun(this.db, bodyState);
        break;
      }

      // Dedupe against SEEN, never confirmed (DESIGN §1.5).
      const items = Array.isArray(output)
        ? output
        : Array.isArray((output as Record<string, unknown>)?.items)
          ? ((output as Record<string, unknown>).items as unknown[])
          : [];
      let added = 0;
      for (const it of items) {
        const k = String(readPath(it, dedupeKey) ?? JSON.stringify(it));
        if (!seen.has(k)) {
          seen.add(k);
          added += 1;
        }
      }
      await putLoopAccumulator(this.db, this.cfg.runId, node.id, iteration, {
        seen: [...seen],
        dryRounds: added === 0 ? dryStreak + 1 : 0,
      });
      if (added === 0) {
        dryStreak += 1;
        if (dryStreak >= dryTarget) {
          iteration++;
          break;
        }
      } else {
        dryStreak = 0;
      }
    }
    await this.markDone(state, { node: node.id, iterations: iteration, seen: [...seen] });
  }

  // ── Leaf execution (agent/tool via the pluggable executor) ─────────────────

  private launchLeaves(): number {
    let launched = 0;
    const cap = this.cfg.caps.maxConcurrentModelCalls;
    for (const state of this.readySnapshot()) {
      if (this.cancelled) break;
      const node = state.node;
      if (this.isStructural(node) || node.type === "human") continue; // settled elsewhere
      if (this.running >= cap) break; // cap reached this pass
      // Budget gate (DESIGN §1.8): no NEW dynamic nodes past the ceiling.
      if (
        this.cfg.tokenBudget != null &&
        this.tokensSpent >= this.cfg.tokenBudget &&
        state.dynamic
      ) {
        void this.skip(state);
        continue;
      }
      this.launchLeaf(state);
      launched += 1;
    }
    return launched;
  }

  private launchLeaf(state: NodeRunState): void {
    state.status = "running";
    state.startedAt = nowIso();
    state.attempts += 1;
    this.running += 1;
    const ks = keyStr(state.key);
    const input = this.buildExecInput(state);
    const p = (async () => {
      try {
        await store.updateNodeRun(this.db, state);
        state.inputRef = await putInputArtifact(this.db, this.cfg.runId, state, input.deps);
        const res = await this.executor.invoke(input, this.abort.signal);
        if (this.cancelled) {
          state.status = "failed";
          state.error = "cancelled";
        } else {
          state.tokensSpent = res.tokensSpent; // capture usage in-closure (§4.2)
          this.tokensSpent += res.tokensSpent;
          state.outputRef = await putOutputArtifact(this.db, this.cfg.runId, state, res.output);
          this.outputs.set(ks, res.output);
          state.status = "done";
        }
      } catch (err) {
        state.status = "failed";
        state.error = err instanceof Error ? err.message : String(err);
      } finally {
        state.completedAt = nowIso();
        this.running -= 1;
        this.inFlight.delete(ks);
        await store.updateNodeRun(this.db, state);
      }
    })();
    this.inFlight.set(ks, p);
  }

  private buildExecInput(state: NodeRunState): NodeExecutionInput {
    const deps: Record<string, unknown> = {};
    for (const d of this.resolveDeps(state)) {
      deps[d.nodeId] = this.outputs.get(keyStr(d.key));
    }
    const myFanout = enclosingFanout(this.g, state.node.id);
    let item: unknown;
    if (myFanout) {
      const scope = this.fanoutScopes.get(myFanout);
      if (scope) item = scope.items[state.key.fanoutIndex];
    }
    return {
      node: state.node,
      deps,
      item,
      fanoutIndex: state.key.fanoutIndex,
      iteration: state.key.iteration,
    };
  }

  /** Read a loop accumulator (test convenience). */
  async readAccumulator(loopNodeId: string, iteration: number) {
    return getLoopAccumulator(this.db, this.cfg.runId, loopNodeId, iteration);
  }
}
