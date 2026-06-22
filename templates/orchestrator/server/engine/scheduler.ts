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

import type { Edge, Node, WorkflowGraph } from "../../shared/types.js";
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
  NodeExecutionResult,
  NodeExecutor,
  NodeRunKey,
  NodeRunState,
  RunConfig,
} from "./types.js";
import { keyStr } from "./types.js";
import {
  TokenBudgetExceededError,
  isVMCapacityExhausted,
} from "../runtime/backpressure.js";

/**
 * Resolve a subworkflow `templateRef` to its graph for inline expansion
 * (DESIGN §1.2/§3.1). Returns null/undefined when the ref cannot be resolved.
 */
export type SubworkflowResolver = (
  templateRef: string,
) => WorkflowGraph | null | undefined;

/**
 * An optional per-node pre-execution GATE (DESIGN §6.2b L1). Before a leaf node
 * runs, the scheduler asks the gate whether it may proceed. Returning `ok:false`
 * fails the node (and so the run) with `reason` — this is how the finalize-status
 * library node asserts the agent set a sensible business status before `end`,
 * without coupling the deterministic scheduler to the work-item DB schema.
 *
 * The gate is consulted ONLY for leaf nodes the scheduler would otherwise hand
 * to the executor; it must be side-effect-free with respect to topology.
 */
export type NodeGate = (
  node: Node,
) => Promise<{ ok: boolean; reason?: string }>;

/** Final run outcome the driver returns. */
export interface RunOutcome {
  runId: string;
  status: "done" | "failed" | "cancelled" | "paused";
  tokensSpent: number;
  nodeRuns: NodeRunState[];
  /** True when the run is parked on a human gate (awaiting-approval node). */
  awaitingApproval?: boolean;
  /**
   * True when the run hit its token-budget ceiling and refused to schedule new
   * dynamic nodes (DESIGN §1.8). DISTINCT from `vmCapacityExhausted` — a budget
   * stop is economic, not a capacity backpressure (§4.1).
   */
  budgetExceeded?: boolean;
  /**
   * True when at least one node failed because the maxConcurrentVMs ceiling was
   * exhausted (DESIGN §4.1 VMCapacityExhaustedError). Reported SEPARATELY from
   * `budgetExceeded` so a VM-bound run hitting the VM cap is never mislabeled a
   * budget overrun.
   */
  vmCapacityExhausted?: boolean;
}

/** A distinct error class so a per-node timeout is reportable as such (§3.4). */
export class NodeTimeoutError extends Error {
  constructor(nodeId: string, timeoutMs: number) {
    super(`node '${nodeId}' exceeded timeoutMs=${timeoutMs}`);
    this.name = "NodeTimeoutError";
  }
}

/** A logical fanout scope materialized at run time. */
interface FanoutScope {
  fanoutNodeId: string;
  items: unknown[];
  width: number;
}

/** The decision a resolved human gate carries in its journaled output. */
export type HumanDecision = "approve" | "reject";

/** Build the journaled output of a resolved human gate (DESIGN §3.1/§11). */
export function humanGateOutput(
  decision: HumanDecision,
  input?: unknown,
): {
  node: "human";
  decision: HumanDecision;
  input: unknown;
} {
  return { node: "human", decision, input: input ?? null };
}

/** Read the decision a human node's output journals, or null if not a gate. */
function humanDecisionOf(output: unknown): HumanDecision | null {
  if (output && typeof output === "object") {
    const d = (output as Record<string, unknown>).decision;
    if (d === "approve" || d === "reject") return d;
  }
  return null;
}

/**
 * Return a graph with per-run node overrides applied (DESIGN §4.3). Pure +
 * immutable: clones every patched node, never mutating the input graph or the
 * shared template — the override is scoped to one run.
 */
function applyNodeOverrides(
  graph: WorkflowGraph,
  overrides: RunConfig["nodeOverrides"],
): WorkflowGraph {
  if (!overrides || Object.keys(overrides).length === 0) return graph;
  const nodes = graph.nodes.map((n) => {
    const patch = overrides[n.id];
    if (!patch) return n;
    const next: Node = { ...n };
    if (typeof patch.prompt === "string") next.prompt = patch.prompt;
    if (typeof patch.model === "string") next.model = patch.model;
    if (typeof patch.engine === "string") next.engine = patch.engine;
    if (patch.effort) next.effort = patch.effort;
    return next;
  });
  return { nodes, edges: graph.edges };
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
  private paused = false;
  private readonly abort = new AbortController();
  private tokensSpent = 0;
  /** Set once the token-budget ceiling refused a new dynamic node (§1.8). */
  private budgetExceeded = false;
  /** Set once a node failed on VM-capacity exhaustion (§4.1) — kept DISTINCT. */
  private vmCapacityExhausted = false;
  /** Resolves a subworkflow `templateRef` to its graph for inline expansion. */
  private readonly resolveTemplate: SubworkflowResolver | null;
  /** Subworkflow nodes already inline-expanded (id → child node ids). */
  private readonly expandedSubworkflows = new Set<string>();
  /** Optional per-node pre-execution gate (DESIGN §6.2b L1 finalize-status). */
  private readonly nodeGate: NodeGate | null;

  constructor(args: {
    cfg: RunConfig;
    db: Db;
    executor: NodeExecutor;
    /** Resolve a subworkflow templateRef → its graph (DESIGN §1.2/§3.1). */
    resolveTemplate?: SubworkflowResolver;
    /** Pre-execution gate for leaf nodes (DESIGN §6.2b L1). */
    nodeGate?: NodeGate;
  }) {
    this.cfg = args.cfg;
    this.db = args.db;
    this.executor = args.executor;
    this.resolveTemplate = args.resolveTemplate ?? null;
    this.nodeGate = args.nodeGate ?? null;
    this.g = buildGraphModel(
      applyNodeOverrides(args.cfg.graph, args.cfg.nodeOverrides),
    );
  }

  cancel(): void {
    this.cancelled = true;
    this.abort.abort();
  }

  /**
   * Cooperative pause (DESIGN §4.3): stop scheduling NEW nodes; let running
   * settle. Unlike cancel it does NOT abort in-flight work — the run quiesces to
   * `paused` and a later run-resume picks the journal up.
   */
  pause(): void {
    this.paused = true;
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
      await this.ensureRun(
        n,
        { nodeId: n.id, iteration: 0, fanoutIndex: 0 },
        false,
      );
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
        lastHeartbeat: r.lastHeartbeat ?? null,
      };
      this.runs.set(keyStr(key), state);
    }

    // Pass 1: dirty = failed | pending | ready (not yet completed) ...
    const dirty = new Set<string>();
    for (const s of this.runs.values()) {
      if (
        s.status === "failed" ||
        s.status === "pending" ||
        s.status === "ready"
      ) {
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
          this.fanoutScopes.set(s.node.id, {
            fanoutNodeId: s.node.id,
            items,
            width: w,
          });
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
      if (
        !this.runs.has(keyStr({ nodeId: n.id, iteration: 0, fanoutIndex: 0 }))
      ) {
        await this.ensureRun(
          n,
          { nodeId: n.id, iteration: 0, fanoutIndex: 0 },
          false,
        );
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

    // A run-cancel marks every still-pending/ready/awaiting node skipped so the
    // run is fully terminal (DESIGN §4.3: pending → skipped).
    if (this.cancelled) await this.skipUnsettledForCancel();

    const states = [...this.runs.values()];
    const anyFailed = states.some((r) => r.status === "failed");
    // A run that quiesced with a node parked on a human gate is `paused`, not
    // done — downstream of the gate is still pending (DESIGN §3.1/§11).
    const awaitingApproval = states.some(
      (r) => r.status === "awaiting-approval",
    );
    let status: RunOutcome["status"];
    if (this.cancelled) status = "cancelled";
    else if (anyFailed) status = "failed";
    else if (this.paused || awaitingApproval) status = "paused";
    else status = "done";
    return {
      runId: this.cfg.runId,
      status,
      tokensSpent: this.tokensSpent,
      nodeRuns: states,
      awaitingApproval,
      budgetExceeded: this.budgetExceeded,
      vmCapacityExhausted: this.vmCapacityExhausted,
    };
  }

  /** Cancel cooperatively: any not-yet-terminal NodeRun becomes `skipped`. */
  private async skipUnsettledForCancel(): Promise<void> {
    for (const s of this.runs.values()) {
      if (
        s.status === "pending" ||
        s.status === "ready" ||
        s.status === "awaiting-approval"
      ) {
        s.status = "skipped";
        s.completedAt = s.completedAt ?? nowIso();
        await store.updateNodeRun(this.db, s);
      }
    }
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
      // When paused we stop scheduling NEW work (no structural settle, no leaf
      // launch). Already-running leaves keep going and settle via drive().
      if (this.paused) break;
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
      lastHeartbeat: null,
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
      // ASYNC / fire-and-forget (DESIGN §3.2): an `await:false` dep does NOT
      // block its downstream barrier. The moment the async node is in flight
      // (running) its edge counts as a live path, so the successor (and any
      // join over it) proceeds WITHOUT waiting for it to settle. The async
      // NodeRun stays in `inFlight`, so the RUN itself still waits for it to
      // settle before finishing (drive() exits only when inFlight is empty).
      // A branch edge is never treated as pre-settled this way — a routing
      // decision is only known once the branch is actually done.
      if (
        dep.status === "running" &&
        dep.node.await === false &&
        !isBranchEdge
      ) {
        live += 1;
        continue;
      }
      if (dep.status !== "done") {
        pending += 1;
        continue;
      }
      // A REJECTED human gate is done but kills its out-edge branch (DESIGN
      // §3.1/§11): its downstream is a dead path, exactly like a not-taken
      // branch edge. The decision is journaled in the human node's output.
      if (
        dep.node.type === "human" &&
        humanDecisionOf(this.outputs.get(keyStr(depKey))) === "reject"
      ) {
        dead += 1;
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
  private resolveDeps(
    state: NodeRunState,
  ): { nodeId: string; key: NodeRunKey }[] {
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

  /**
   * True when a dependency NodeRun satisfies a downstream BARRIER (a join or a
   * parallel-after). A terminal status (done/failed/skipped) always satisfies.
   * An `await:false` (fire-and-forget, DESIGN §3.2) dep satisfies the barrier
   * the moment it is `running` — the barrier does NOT wait for it to settle.
   * The async NodeRun stays in `inFlight`, so the RUN still waits for it before
   * finishing; only the topology barrier is released early.
   */
  private barrierSatisfied(dep: NodeRunState | undefined): boolean {
    if (!dep) return false;
    if (
      dep.status === "done" ||
      dep.status === "failed" ||
      dep.status === "skipped"
    ) {
      return true;
    }
    return dep.status === "running" && dep.node.await === false;
  }

  private joinReady(state: NodeRunState): boolean {
    const fanoutId = nearestUpstreamFanout(this.g, state.node.id);
    if (!fanoutId) {
      // Plain barrier over direct predecessors.
      return this.resolveDeps(state).every((d) =>
        this.barrierSatisfied(this.runs.get(keyStr(d.key))),
      );
    }
    const scope = this.fanoutScopes.get(fanoutId);
    if (!scope) return false; // array not materialized → not sealed yet

    const feeders = inEdges(this.g, state.node.id).filter(
      (e) => enclosingFanout(this.g, e.from) === fanoutId,
    );
    if (feeders.length === 0) return false;
    // Wait until EVERY index has settled (or is an in-flight await:false) for
    // every feeder.
    for (let i = 0; i < scope.width; i++) {
      for (const f of feeders) {
        const dep = this.runs.get(
          keyStr({
            nodeId: f.from,
            iteration: state.key.iteration,
            fanoutIndex: i,
          }),
        );
        if (!this.barrierSatisfied(dep)) return false;
      }
    }
    return true;
  }

  // ── Skip propagation ───────────────────────────────────────────────────────

  private async skip(state: NodeRunState, reason?: string): Promise<void> {
    if (state.status === "skipped") return;
    state.status = "skipped";
    state.completedAt = nowIso();
    // A reason (e.g. the token-budget stop, §1.8) is journaled on the row so the
    // run/node observers can distinguish a budget-skip from a dead-branch skip.
    if (reason) state.error = reason;
    await store.updateNodeRun(this.db, state);
    // Eagerly create the exclusive downstream so a skipped branch terminates;
    // each downstream is re-evaluated in computeReadiness (it may still have a
    // live path via a join, in which case it is NOT skipped here).
    for (const e of outEdges(this.g, state.node.id)) {
      const child = this.g.byId.get(e.to);
      if (!child) continue;
      const sameScope =
        enclosingFanout(this.g, e.to) ===
        enclosingFanout(this.g, state.node.id);
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
    if (node.type === "subworkflow") {
      await this.expandSubworkflow(state);
      return;
    }
    // start / end / parallel / branch / join: aggregate + done.
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
              keyStr({
                nodeId: f.from,
                iteration: state.key.iteration,
                fanoutIndex: i,
              }),
            );
            if (dep?.status === "done")
              merged.push(this.outputs.get(keyStr(dep.key)));
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
    state.outputRef = await putOutputArtifact(
      this.db,
      this.cfg.runId,
      state,
      output,
    );
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
    const cap =
      node.maxConcurrency && node.maxConcurrency > 0
        ? node.maxConcurrency
        : arr.length;
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

  // ── Subworkflow inline expansion (DESIGN §1.2 / §3.1) ──────────────────────

  /**
   * Inline-expand a subworkflow node: resolve its referenced template's graph,
   * namespace every child node/edge, and splice the child subgraph BETWEEN this
   * node and its successors so the child runs as part of THIS run — sharing the
   * parent's concurrency caps, token budget and node backstop (no separate
   * quota). Child tokens accrue to the parent run because every child leaf goes
   * through the same launchLeaf path (DESIGN §1.2).
   *
   * ONE LEVEL ONLY: if the referenced template itself contains a subworkflow
   * node, the expansion is REJECTED (two-level nesting) and this node fails.
   */
  private async expandSubworkflow(state: NodeRunState): Promise<void> {
    const node = state.node;
    if (this.expandedSubworkflows.has(node.id)) {
      // Already expanded on a prior pass (e.g. resume) — just aggregate + done.
      await this.markDone(state, this.aggregateOutput(state));
      return;
    }
    const ref = node.templateRef;
    if (!ref) {
      await this.failStructural(
        state,
        `subworkflow '${node.id}' has no templateRef`,
      );
      return;
    }
    if (!this.resolveTemplate) {
      await this.failStructural(
        state,
        `subworkflow '${node.id}' cannot expand: no template resolver wired`,
      );
      return;
    }
    const child = this.resolveTemplate(ref);
    if (!child) {
      await this.failStructural(
        state,
        `subworkflow '${node.id}' references unknown template '${ref}'`,
      );
      return;
    }
    // Two-level nesting guard (DESIGN §1.2/§3.1): reject AT expansion.
    if (child.nodes.some((n) => n.type === "subworkflow")) {
      await this.failStructural(
        state,
        `subworkflow '${node.id}' references template '${ref}' which itself ` +
          `contains a subworkflow node (two-level nesting is not allowed)`,
      );
      return;
    }

    const childStart = child.nodes.find((n) => n.type === "start");
    const childEnd = child.nodes.find((n) => n.type === "end");
    if (!childStart || !childEnd) {
      await this.failStructural(
        state,
        `subworkflow '${node.id}' template '${ref}' must have one start and one end`,
      );
      return;
    }

    const ns = (id: string) => `${node.id}::${id}`;
    // 1. Splice child nodes (namespaced) into the live graph as dynamic runs.
    for (const cn of child.nodes) {
      const renamed = this.renameNode(cn, ns);
      this.addGraphNode(renamed);
      await this.ensureRun(
        renamed,
        { nodeId: renamed.id, iteration: state.key.iteration, fanoutIndex: 0 },
        true,
      );
    }
    // 2. Child-internal edges (namespaced).
    for (const ce of child.edges) {
      this.addGraphEdge({
        id: ns(ce.id),
        from: ns(ce.from),
        to: ns(ce.to),
        when: ce.when,
      });
    }
    // 3. Splice: this node → child start; child end → each original successor.
    const originalOut = outEdges(this.g, node.id);
    this.addGraphEdge({
      id: `${node.id}::enter`,
      from: node.id,
      to: ns(childStart.id),
    });
    for (const e of originalOut) {
      this.removeGraphEdge(e.id);
      this.addGraphEdge({
        id: `${node.id}::exit::${e.id}`,
        from: ns(childEnd.id),
        to: e.to,
        when: e.when,
      });
    }
    this.expandedSubworkflows.add(node.id);
    // The subworkflow node itself settles done (it is a container marker); the
    // spliced child subgraph carries the actual work.
    await this.markDone(state, {
      node: node.id,
      type: "subworkflow",
      templateRef: ref,
      expanded: child.nodes.length,
    });
  }

  /** Mark a structural node failed with an error (subworkflow expansion errors). */
  private async failStructural(
    state: NodeRunState,
    message: string,
  ): Promise<void> {
    state.status = "failed";
    state.error = message;
    state.completedAt = nowIso();
    await store.updateNodeRun(this.db, state);
  }

  /** Clone a node under a renamed id, remapping its container `children` refs. */
  private renameNode(n: Node, ns: (id: string) => string): Node {
    const copy: Node = { ...n, id: ns(n.id) };
    if (Array.isArray(n.children)) copy.children = n.children.map(ns);
    if (typeof n.itemsFrom === "string") copy.itemsFrom = ns(n.itemsFrom);
    return copy;
  }

  /** Add a node to the live GraphModel adjacency (idempotent on id). */
  private addGraphNode(n: Node): void {
    if (this.g.byId.has(n.id)) return;
    this.g.nodes.push(n);
    this.g.byId.set(n.id, n);
    this.g.out.set(n.id, this.g.out.get(n.id) ?? []);
    this.g.in.set(n.id, this.g.in.get(n.id) ?? []);
    this.g.containerOf.set(n.id, this.g.containerOf.get(n.id) ?? null);
    if (Array.isArray(n.children) && n.children.length > 0) {
      this.g.childrenOf.set(n.id, n.children.slice());
      for (const c of n.children) this.g.containerOf.set(c, n.id);
    }
  }

  /** Add an edge to the live GraphModel adjacency. */
  private addGraphEdge(e: Edge): void {
    this.g.edges.push(e);
    if (this.g.byId.has(e.from) && this.g.byId.has(e.to)) {
      this.g.out.get(e.from)!.push(e.to);
      this.g.in.get(e.to)!.push(e.from);
    }
  }

  /** Remove an edge by id from the live GraphModel adjacency. */
  private removeGraphEdge(edgeId: string): void {
    const idx = this.g.edges.findIndex((e) => e.id === edgeId);
    if (idx < 0) return;
    const e = this.g.edges[idx];
    this.g.edges.splice(idx, 1);
    const outs = this.g.out.get(e.from);
    if (outs) {
      const i = outs.indexOf(e.to);
      if (i >= 0) outs.splice(i, 1);
    }
    const ins = this.g.in.get(e.to);
    if (ins) {
      const i = ins.indexOf(e.from);
      if (i >= 0) ins.splice(i, 1);
    }
  }

  // ── Loop (DESIGN §1.5 / §3.2) ──────────────────────────────────────────────
  //
  // Two modes, picked at dispatch:
  //
  //   1. LOOP-UNTIL-DRY (legacy / finder pattern): body is a SINGLE child agent
  //      that produces an `items` array each round; the loop dedupes by
  //      `dedupeKey` and stops after `dryRounds` consecutive iterations add
  //      nothing new. The original semantics, preserved unchanged.
  //
  //   2. LOOP-UNTIL-CONDITION (sequential body + judgement): when the loop has
  //      >1 child OR an explicit `condition` set, treat `children` as a
  //      SEQUENTIAL pipeline that runs once per iteration (e.g. dev → test →
  //      review → judge). After the pipeline finishes, `condition` is evaluated
  //      against this iteration's child outputs (`deps[<childId>]`) — when truthy,
  //      the loop stops. Iteration N>0's first child sees the prior iteration's
  //      LAST child output via `deps["prev_iteration"]` so a "retry with judge
  //      feedback" workflow is expressible without unrolling.

  private async runLoop(state: NodeRunState): Promise<void> {
    const node = state.node;
    const childIds = node.children ?? [];
    if (childIds.length === 0) {
      await this.markDone(state, { node: node.id, iterations: 0, seen: [] });
      return;
    }
    const useConditionMode = childIds.length > 1 || !!node.condition;
    if (useConditionMode) {
      return this.runLoopUntilCondition(state, childIds);
    }
    return this.runLoopUntilDry(state, childIds[0]);
  }

  /**
   * Loop-until-condition: run `children` sequentially each iteration. Feed each
   * child the prior siblings' outputs (this iteration) plus `prev_iteration`
   * = last child output from the PRIOR iteration. After the iteration, eval
   * `node.condition` against deps={childId: output} — truthy stops the loop.
   */
  private async runLoopUntilCondition(
    state: NodeRunState,
    childIds: string[],
  ): Promise<void> {
    const node = state.node;
    const maxIter = node.maxIterations ?? 1;
    const lastCid = childIds[childIds.length - 1];

    let iteration = 0;
    let aborted = false;
    let conditionMet = false;
    let lastIterFeedback: unknown = undefined;
    let lastIterChildOutputs: Record<string, unknown> = {};

    for (; iteration < maxIter; iteration++) {
      if (this.cancelled) break;

      const iterOutputs: Record<string, unknown> = {};

      for (const cid of childIds) {
        const child = this.g.byId.get(cid);
        if (!child) continue;

        const key: NodeRunKey = { nodeId: cid, iteration, fanoutIndex: 0 };
        const childState = await this.ensureRun(child, key, iteration > 0);
        childState.status = "running";
        childState.startedAt = nowIso();
        childState.attempts += 1;
        await store.updateNodeRun(this.db, childState);

        // Build per-child deps: prior siblings THIS iteration + the last
        // child's output from the PRIOR iteration (the judge's feedback) so
        // the first child of iter N>0 can read why iter N-1 didn't accept.
        const deps: Record<string, unknown> = { ...iterOutputs };
        if (iteration > 0 && lastIterFeedback !== undefined) {
          deps["prev_iteration"] = lastIterFeedback;
        }

        const input: NodeExecutionInput = {
          node: child,
          deps,
          fanoutIndex: 0,
          iteration,
          effort: child.effort,
        };
        try {
          const res = await this.executor.invoke(input, this.abort.signal);
          iterOutputs[cid] = res.output;
          childState.tokensSpent = res.tokensSpent;
          this.tokensSpent += res.tokensSpent;
          childState.outputRef = await putOutputArtifact(
            this.db,
            this.cfg.runId,
            childState,
            res.output,
          );
          childState.status = "done";
          childState.completedAt = nowIso();
          this.outputs.set(keyStr(key), res.output);
          await store.updateNodeRun(this.db, childState);
        } catch (err) {
          childState.status = "failed";
          childState.error = err instanceof Error ? err.message : String(err);
          childState.completedAt = nowIso();
          await store.updateNodeRun(this.db, childState);
          aborted = true;
          break;
        }
      }

      lastIterChildOutputs = iterOutputs;
      lastIterFeedback = iterOutputs[lastCid];

      if (aborted) {
        iteration++;
        break;
      }

      if (node.condition) {
        const ctx: ConditionContext = { deps: iterOutputs, status: {} };
        if (evalCondition(node.condition, ctx)) {
          conditionMet = true;
          iteration++;
          break;
        }
      }
    }

    await this.markDone(state, {
      node: node.id,
      iterations: iteration,
      accepted: conditionMet,
      aborted,
      lastIterOutputs: lastIterChildOutputs,
    });
  }

  /** Original loop-until-dry behavior (unchanged). */
  private async runLoopUntilDry(
    state: NodeRunState,
    bodyId: string,
  ): Promise<void> {
    const node = state.node;
    if (!this.g.byId.has(bodyId)) {
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
      const input: NodeExecutionInput = {
        node: bodyNode,
        deps: {},
        fanoutIndex: 0,
        iteration,
        effort: bodyNode.effort,
      };
      let output: unknown;
      try {
        const res = await this.executor.invoke(input, this.abort.signal);
        output = res.output;
        bodyState.tokensSpent = res.tokensSpent;
        this.tokensSpent += res.tokensSpent;
        bodyState.outputRef = await putOutputArtifact(
          this.db,
          this.cfg.runId,
          bodyState,
          output,
        );
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
    await this.markDone(state, {
      node: node.id,
      iterations: iteration,
      seen: [...seen],
    });
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
      // Budget gate (DESIGN §1.8 — the EXACT stop): once spend ≥ budget, refuse
      // any NEW dynamic node. This is an economic stop surfaced as
      // `budgetExceeded` (a TokenBudgetExceededError type), kept DISTINCT from
      // the VM-capacity backpressure (§4.1). A static (template) node is NOT
      // gated — only the brain's runtime-added dynamic nodes are budget-bound.
      if (
        this.cfg.tokenBudget != null &&
        this.tokensSpent >= this.cfg.tokenBudget &&
        state.dynamic
      ) {
        // Record the budget breach as the distinct typed reason on the skipped
        // node so node-get/run-get can show "stopped: token budget exhausted"
        // rather than a generic skip, and flag the run outcome.
        this.budgetExceeded = true;
        const err = new TokenBudgetExceededError(
          this.cfg.tokenBudget,
          this.tokensSpent,
        );
        void this.skip(state, err.message);
        continue;
      }
      this.launchLeaf(state);
      launched += 1;
    }
    return launched;
  }

  private launchLeaf(state: NodeRunState): void {
    state.status = "running";
    const now = nowIso();
    state.startedAt = now;
    state.lastHeartbeat = now; // liveness for the reap loop (§6.4/§13)
    state.attempts += 1;
    this.running += 1;
    const ks = keyStr(state.key);
    const input = this.buildExecInput(state);
    const p = (async () => {
      try {
        await store.updateNodeRun(this.db, state);
        state.inputRef = await putInputArtifact(
          this.db,
          this.cfg.runId,
          state,
          input.deps,
        );
        // GATE (DESIGN §6.2b L1): a node may carry a pre-execution gate (the
        // finalize-status library node). If the gate denies, the node fails
        // BEFORE the executor runs — the run cannot finish unfinalized.
        if (this.nodeGate) {
          const gate = await this.nodeGate(state.node);
          if (!gate.ok) {
            throw new Error(
              gate.reason ?? `node '${state.node.id}' gate denied`,
            );
          }
        }
        const res = await this.invokeWithTimeout(state, input);
        if (this.cancelled) {
          state.status = "failed";
          state.error = "cancelled";
        } else {
          state.tokensSpent = res.tokensSpent; // capture usage in-closure (§4.2)
          this.tokensSpent += res.tokensSpent;
          state.outputRef = await putOutputArtifact(
            this.db,
            this.cfg.runId,
            state,
            res.output,
          );
          this.outputs.set(ks, res.output);
          state.status = "done";
        }
      } catch (err) {
        state.status = "failed";
        state.error = err instanceof Error ? err.message : String(err);
        // VM-capacity exhaustion (§4.1) is recorded as a DISTINCT outcome flag —
        // a VM-bound run hitting the maxConcurrentVMs cap must never be reported
        // as a token-budget overrun. The node row keeps the typed error message.
        if (isVMCapacityExhausted(err)) this.vmCapacityExhausted = true;
      } finally {
        state.completedAt = nowIso();
        state.lastHeartbeat = null; // settled → no longer a reap candidate
        this.running -= 1;
        this.inFlight.delete(ks);
        await store.updateNodeRun(this.db, state);
      }
    })();
    this.inFlight.set(ks, p);
  }

  /**
   * Run a node's executor, enforcing its per-node `timeoutMs` (DESIGN §3.4 /
   * §12.1 — day-one liveness). A node that exceeds its timeout is aborted via a
   * node-scoped signal and rejected with a DISTINCT NodeTimeoutError so the
   * failure is reportable as a timeout (not a generic error). The timeout is an
   * exception/liveness path only — it never feeds readiness, fanout width,
   * branch selection or artifact ids, so the determinism invariant holds.
   */
  private async invokeWithTimeout(
    state: NodeRunState,
    input: NodeExecutionInput,
  ): Promise<NodeExecutionResult> {
    const timeoutMs = state.node.timeoutMs;
    if (timeoutMs == null || timeoutMs <= 0) {
      return this.executor.invoke(input, this.abort.signal);
    }
    // Combine the run-level abort with a node-scoped timeout abort.
    const nodeAbort = new AbortController();
    const onRunAbort = () => nodeAbort.abort();
    this.abort.signal.addEventListener("abort", onRunAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutP = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        nodeAbort.abort();
        reject(new NodeTimeoutError(state.node.id, timeoutMs));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        this.executor.invoke(input, nodeAbort.signal),
        timeoutP,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.abort.signal.removeEventListener("abort", onRunAbort);
    }
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
      effort: state.node.effort,
    };
  }

  /** Read a loop accumulator (test convenience). */
  async readAccumulator(loopNodeId: string, iteration: number) {
    return getLoopAccumulator(this.db, this.cfg.runId, loopNodeId, iteration);
  }
}
