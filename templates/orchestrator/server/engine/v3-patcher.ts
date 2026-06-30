// V3 Patch System (DESIGN §8.6, IMPLEMENTATION P2 §A)
//
// CAS-protected mid-run DAG mutation.  Supports five mutation types:
// modify_node, add_node, remove_node, modify_loop, replace_dag.
// Every patch is validated (structural + acyclic) before it touches the run.
//
// G15: The CAS version read, per-node status recheck, and dag_version UPDATE
// are performed inside a SINGLE transaction.  The UPDATE uses .returning() to
// assert exactly one row was changed; if zero rows are returned (meaning another
// writer raced us and bumped dag_version) the transaction throws, rolling back,
// and we return { error: "version_conflict" }.

import { eq, and, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { customAlphabet } from "nanoid";
import { v3Runs, v3Nodes, v3Patches } from "../db/v3-schema.js";
import type { InferSelectModel } from "drizzle-orm";
import { validateDag, detectCycle } from "./dag-validator.js";
import type {
  V3Dag,
  V3Node,
  V3AgentNode,
  V3LoopNode,
} from "./dag-validator.js";

// ── Types ────────────────────────────────────────────────────────────────────

type RunRow = InferSelectModel<typeof v3Runs>;
type NodeRow = InferSelectModel<typeof v3Nodes>;

const gen = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

function patchId(): string {
  return `patch_${gen()}`;
}

/** Node statuses that are safe to remove (not yet committed to output). */
const REMOVABLE_STATUSES = new Set(["pending", "skipped"]);

/** Node statuses considered terminal (completed work). */
const TERMINAL_STATUSES = new Set(["done", "failed", "skipped"]);

/** Node statuses that are behind or at the frontier — immutable (I5/I9). */
const IMMUTABLE_STATUSES = new Set(["running", "done", "failed"]);

// ── Mutation types ───────────────────────────────────────────────────────────

/**
 * Modify an existing agent node's editable fields.
 * Allowed: prompt, model_override, guard, deps (§8.6 design spec).
 * Ready nodes are atomically demoted to pending before edit (G11).
 */
interface ModifyNodeMutation {
  kind: "modify_node";
  nodeIdInDag: string;
  prompt?: string;
  model_override?: string;
  guard?: string;
  deps?: string[];
}

/** Add a brand-new node to the DAG. */
interface AddNodeMutation {
  kind: "add_node";
  node: V3Node;
}

/** Remove a node from the DAG (must be pending or skipped in v3_nodes). */
interface RemoveNodeMutation {
  kind: "remove_node";
  nodeIdInDag: string;
}

/**
 * Modify a loop node's max_iterations and/or until expression.
 * Ready/running body nodes are handled per §9 (loop mid-run scoping).
 * The loop control node itself is checked for immutability (G11).
 */
interface ModifyLoopMutation {
  kind: "modify_loop";
  nodeIdInDag: string;
  maxIterations?: number;
  until?: string;
}

/** Replace the entire DAG nodes array. */
interface ReplaceDagMutation {
  kind: "replace_dag";
  nodes: V3Node[];
}

export type DagMutation =
  | ModifyNodeMutation
  | AddNodeMutation
  | RemoveNodeMutation
  | ModifyLoopMutation
  | ReplaceDagMutation;

// ── Request / Response ───────────────────────────────────────────────────────

export interface ApplyPatchParams {
  runId: string;
  dagVersion: number;
  mutations: DagMutation[];
  appliedBy: string;
  reason?: string;
}

export type ApplyPatchResult =
  | { success: true; newDagVersion: number; patchId: string }
  | {
      success: false;
      error:
        | "version_conflict"
        | "validation_failed"
        | "removal_blocked"
        | "node_not_patchable"
        | string;
      currentDagVersion?: number;
      nodeId?: string;
      nodeStatus?: string;
      errors?: string[];
    };

// Internal sentinel thrown inside the transaction to signal known failure kinds
// without losing the structured error info through Drizzle's rollback path.
class PatchError extends Error {
  constructor(
    public readonly result: ApplyPatchResult & { success: false },
  ) {
    super(result.error);
    this.name = "PatchError";
  }
}

// ── Patcher ──────────────────────────────────────────────────────────────────

export class V3Patcher {
  private readonly db: PostgresJsDatabase;

  constructor(db: PostgresJsDatabase) {
    this.db = db;
  }

  /**
   * Apply a batch of DAG mutations to a running V3 run.
   *
   * The batch is atomic: either all mutations succeed together, or none are
   * applied.  All reads, status checks, and the dag_version UPDATE happen
   * inside a single transaction (G15).  A CAS on the UPDATE's WHERE clause
   * plus a returning() row-count assertion catches races where another writer
   * incremented dag_version between our read and our write.
   */
  public async applyPatch(params: ApplyPatchParams): Promise<ApplyPatchResult> {
    const { runId, dagVersion, mutations, appliedBy, reason } = params;

    const id = patchId();
    const now = new Date();

    try {
      const newDagVersion = await this.db.transaction(async (tx) => {
        // ── Step 1: Read run row (inside tx for serializability) ──────────
        const [run] = await (tx as any)
          .select()
          .from(v3Runs)
          .where(eq(v3Runs.id, runId));

        if (!run) {
          throw new PatchError({
            success: false,
            error: `Run ${runId} not found`,
          });
        }

        // ── Step 2: CAS check ─────────────────────────────────────────────
        if (run.dagVersion !== dagVersion) {
          throw new PatchError({
            success: false,
            error: "version_conflict",
            currentDagVersion: run.dagVersion,
          });
        }

        // ── Step 3: Parse current DAG ─────────────────────────────────────
        const currentDag = this.parseDag(run.dag);
        if (!currentDag) {
          throw new PatchError({
            success: false,
            error: "Failed to parse current DAG",
          });
        }

        // ── Step 4: Read current node rows (inside tx) ────────────────────
        const nodeRows: NodeRow[] = await (tx as any)
          .select()
          .from(v3Nodes)
          .where(eq(v3Nodes.runId, runId));

        // ── Step 5: Collect ready nodes that need demotion ─────────────────
        // Any node targeted by modify_node/modify_loop that is currently
        // "ready" must be demoted to "pending" before editing so the
        // reconciler re-evaluates it after the patch (§8.6 rule 2 / G11).
        const readyNodesToDemote = this.collectReadyDemotions(
          mutations,
          nodeRows,
        );

        // ── Step 6: Apply mutations to a DAG snapshot ─────────────────────
        const newDag = structuredClone(currentDag);
        const applyResult = this.applyMutations(newDag, mutations, nodeRows);
        if (!applyResult.ok) {
          throw new PatchError({
            success: false,
            error: applyResult.error,
            nodeId: applyResult.nodeId,
            nodeStatus: applyResult.nodeStatus,
            errors: applyResult.errors,
          });
        }

        // ── Step 7: Validate resulting DAG ────────────────────────────────
        const validation = validateDag(newDag);
        if (!validation.ok) {
          throw new PatchError({
            success: false,
            error: "validation_failed",
            errors: validation.errors,
          });
        }

        // ── Step 8: Demote ready nodes to pending (G11) ───────────────────
        if (readyNodesToDemote.length > 0) {
          await (tx as any)
            .update(v3Nodes)
            .set({ status: "pending" })
            .where(
              and(
                eq(v3Nodes.runId, runId),
                inArray(v3Nodes.nodeIdInDag, readyNodesToDemote),
              ),
            );
        }

        // ── Step 9: Insert patch record ───────────────────────────────────
        const newVersion = dagVersion + 1;
        await (tx as any).insert(v3Patches).values({
          id,
          runId,
          dagVersionBefore: dagVersion,
          dagVersionAfter: newVersion,
          patchOps: mutations,
          actor: appliedBy,
          reason: reason ?? null,
          applied: 1,
          appliedAt: now,
          ownerEmail: "local@localhost",
          orgId: null,
        });

        // ── Step 10: CAS UPDATE with returning() row-count assertion (G15) ─
        // The WHERE clause re-asserts dag_version = expected.  If another
        // writer bumped the version since Step 2, zero rows are returned
        // here and we roll back with version_conflict.
        const updated = await (tx as any)
          .update(v3Runs)
          .set({ dag: newDag, dagVersion: newVersion })
          .where(
            and(eq(v3Runs.id, runId), eq(v3Runs.dagVersion, dagVersion)),
          )
          .returning({ id: v3Runs.id });

        if (!updated || updated.length === 0) {
          throw new PatchError({
            success: false,
            error: "version_conflict",
            currentDagVersion: undefined, // unknown at this point
          });
        }

        return newVersion;
      });

      return { success: true, newDagVersion, patchId: id };
    } catch (err) {
      if (err instanceof PatchError) {
        return err.result;
      }
      throw err;
    }
  }

  // ── Ready-demotion helper ────────────────────────────────────────────────

  /**
   * Identify node ids that are currently "ready" and are targeted by
   * modify_node or modify_loop mutations.  These must be demoted to
   * "pending" inside the transaction so the reconciler re-evaluates them.
   */
  private collectReadyDemotions(
    mutations: DagMutation[],
    nodeRows: NodeRow[],
  ): string[] {
    const readySet = new Set(
      nodeRows
        .filter((r) => r.status === "ready")
        .map((r) => r.nodeIdInDag),
    );

    const demote: string[] = [];
    for (const m of mutations) {
      if (
        (m.kind === "modify_node" || m.kind === "modify_loop") &&
        readySet.has(m.nodeIdInDag)
      ) {
        demote.push(m.nodeIdInDag);
      }
    }
    return demote;
  }

  // ── Mutation application ─────────────────────────────────────────────────

  /**
   * Apply mutations sequentially to a DAG snapshot.
   * Returns early on the first mutation error.
   */
  private applyMutations(
    dag: V3Dag,
    mutations: DagMutation[],
    nodeRows: NodeRow[],
  ):
    | { ok: true }
    | {
        ok: false;
        error: string;
        nodeId?: string;
        nodeStatus?: string;
        errors?: string[];
        currentDagVersion?: number;
      } {
    for (const mutation of mutations) {
      const result = this.applyOne(dag, mutation, nodeRows);
      if (!result.ok) return result;
    }
    return { ok: true };
  }

  private applyOne(
    dag: V3Dag,
    mutation: DagMutation,
    nodeRows: NodeRow[],
  ):
    | { ok: true }
    | { ok: false; error: string; nodeId?: string; nodeStatus?: string; errors?: string[] } {
    switch (mutation.kind) {
      case "modify_node":
        return this.applyModifyNode(dag, mutation, nodeRows);
      case "add_node":
        return this.applyAddNode(dag, mutation);
      case "remove_node":
        return this.applyRemoveNode(dag, mutation, nodeRows);
      case "modify_loop":
        return this.applyModifyLoop(dag, mutation, nodeRows);
      case "replace_dag":
        return this.applyReplaceDag(dag, mutation, nodeRows);
      default:
        return {
          ok: false,
          error: `Unknown mutation kind: ${(mutation as any).kind}`,
        };
    }
  }

  /**
   * modify_node — change prompt, model_override, guard, and/or deps on an
   * agent node.  Per §8.6 / G11:
   *   - running / done (immutable journal)  → node_not_patchable
   *   - ready (queued, not yet dispatched) → demoted to pending in tx (Step 8)
   *     then edited here on the DAG snapshot
   *   - pending → edited in place
   */
  private applyModifyNode(
    dag: V3Dag,
    mutation: ModifyNodeMutation,
    nodeRows: NodeRow[],
  ): { ok: true } | { ok: false; error: string; nodeId?: string; nodeStatus?: string } {
    const node = dag.nodes.find((n) => n.id === mutation.nodeIdInDag);
    if (!node) {
      return {
        ok: false,
        error: `modify_node: node '${mutation.nodeIdInDag}' not found`,
      };
    }
    if (node.type !== "agent") {
      return {
        ok: false,
        error: `modify_node: node '${mutation.nodeIdInDag}' is not an agent node`,
      };
    }

    // G11: check current status from v3_nodes rows
    const nodeRow = nodeRows.find((r) => r.nodeIdInDag === mutation.nodeIdInDag);
    if (nodeRow && IMMUTABLE_STATUSES.has(nodeRow.status)) {
      return {
        ok: false,
        error: "node_not_patchable",
        nodeId: mutation.nodeIdInDag,
        nodeStatus: nodeRow.status,
      };
    }
    // "ready" is allowed — demotion to "pending" is handled separately in
    // collectReadyDemotions + Step 8 of applyPatch.

    const agentNode = node as V3AgentNode;
    if (mutation.prompt !== undefined) {
      agentNode.prompt = mutation.prompt;
    }
    if (mutation.model_override !== undefined) {
      agentNode.model_override = mutation.model_override;
    }
    if (mutation.guard !== undefined) {
      agentNode.guard = mutation.guard;
    }
    if (mutation.deps !== undefined) {
      agentNode.deps = mutation.deps;
    }

    return { ok: true };
  }

  /**
   * add_node — push a new node object onto the DAG.
   * Validates that the node id is not already present.
   */
  private applyAddNode(
    dag: V3Dag,
    mutation: AddNodeMutation,
  ): { ok: true } | { ok: false; error: string } {
    const exists = dag.nodes.some((n) => n.id === mutation.node.id);
    if (exists) {
      return {
        ok: false,
        error: `add_node: node '${mutation.node.id}' already exists in DAG`,
      };
    }
    dag.nodes.push(mutation.node);
    return { ok: true };
  }

  /**
   * remove_node — filter out a node from the DAG.
   * Only allowed if all v3_nodes rows for that nodeIdInDag are pending or skipped.
   */
  private applyRemoveNode(
    dag: V3Dag,
    mutation: RemoveNodeMutation,
    nodeRows: NodeRow[],
  ): { ok: true } | { ok: false; error: string } {
    const hasNode = dag.nodes.some((n) => n.id === mutation.nodeIdInDag);
    if (!hasNode) {
      return {
        ok: false,
        error: `remove_node: node '${mutation.nodeIdInDag}' not found in DAG`,
      };
    }

    const rows = nodeRows.filter(
      (r) => r.nodeIdInDag === mutation.nodeIdInDag,
    );

    for (const row of rows) {
      if (!REMOVABLE_STATUSES.has(row.status)) {
        return {
          ok: false,
          error: `remove_node: node '${mutation.nodeIdInDag}' has status '${row.status}' (must be pending or skipped)`,
        };
      }
    }

    dag.nodes = dag.nodes.filter((n) => n.id !== mutation.nodeIdInDag);
    return { ok: true };
  }

  /**
   * modify_loop — change max_iterations and/or until on a loop node.
   * Per §8.6 / G11:
   *   - running / done on the loop control node → node_not_patchable
   *   - ready loop node → demoted to pending in tx (Step 8), then edited
   *   - pending → edited in place
   *
   * Note: per §9, a running loop body iteration is behind the frontier and
   * is immutable; edits to max_iterations/until take effect at the next
   * iteration boundary, not the current one.
   */
  private applyModifyLoop(
    dag: V3Dag,
    mutation: ModifyLoopMutation,
    nodeRows: NodeRow[],
  ): { ok: true } | { ok: false; error: string; nodeId?: string; nodeStatus?: string } {
    const node = dag.nodes.find((n) => n.id === mutation.nodeIdInDag);
    if (!node) {
      return {
        ok: false,
        error: `modify_loop: node '${mutation.nodeIdInDag}' not found`,
      };
    }
    if (node.type !== "loop") {
      return {
        ok: false,
        error: `modify_loop: node '${mutation.nodeIdInDag}' is not a loop node`,
      };
    }

    // G11: check current status from v3_nodes rows
    const nodeRow = nodeRows.find((r) => r.nodeIdInDag === mutation.nodeIdInDag);
    if (nodeRow && IMMUTABLE_STATUSES.has(nodeRow.status)) {
      return {
        ok: false,
        error: "node_not_patchable",
        nodeId: mutation.nodeIdInDag,
        nodeStatus: nodeRow.status,
      };
    }
    // "ready" is allowed — demotion handled separately.

    const loopNode = node as V3LoopNode;
    if (mutation.maxIterations !== undefined) {
      loopNode.maxIterations = mutation.maxIterations;
    }
    if (mutation.until !== undefined) {
      loopNode.until = mutation.until;
    }

    return { ok: true };
  }

  /**
   * replace_dag — replace the entire nodes array.
   * Constraint: nodes that are currently running or done must keep the same
   * node_id_in_dag + type in the new DAG.
   */
  private applyReplaceDag(
    dag: V3Dag,
    mutation: ReplaceDagMutation,
    nodeRows: NodeRow[],
  ): { ok: true } | { ok: false; error: string } {
    // Find nodes that are running or done
    const activeRows = nodeRows.filter((r) =>
      ["running", "done"].includes(r.status),
    );

    const newNodes = mutation.nodes;
    const newIdMap = new Map(
      newNodes.map((n) => [n.id, n]),
    );

    for (const row of activeRows) {
      const replacement = newIdMap.get(row.nodeIdInDag);
      if (!replacement) {
        return {
          ok: false,
          error: `replace_dag: active node '${row.nodeIdInDag}' (status=${row.status}) missing from new DAG`,
        };
      }
      if (replacement.type !== row.type) {
        return {
          ok: false,
          error: `replace_dag: node '${row.nodeIdInDag}' type changed from '${row.type}' to '${replacement.type}' (not allowed for active nodes)`,
        };
      }
    }

    dag.nodes = newNodes;
    return { ok: true };
  }

  // ── DAG parsing ──────────────────────────────────────────────────────────

  /**
   * Parse the run.dag column (JSONB) into a V3Dag object.
   * Handles both object and string-encoded JSON.
   */
  private parseDag(raw: unknown): V3Dag | null {
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
      } catch {
        return null;
      }
    }
    if (
      raw &&
      typeof raw === "object" &&
      "nodes" in raw &&
      Array.isArray((raw as V3Dag).nodes)
    ) {
      return raw as V3Dag;
    }
    return null;
  }
}

// ── Standalone export ────────────────────────────────────────────────────────

/**
 * Top-level `applyPatch` function for direct import without constructing
 * a V3Patcher instance.  Uses `getV3Db()` internally.
 */
export async function applyPatch(
  runId: string,
  dagVersion: number,
  mutations: DagMutation[],
  appliedBy: string,
  reason?: string,
): Promise<ApplyPatchResult> {
  const { getV3Db } = await import("../db/v3.js");
  const patcher = new V3Patcher(getV3Db() as unknown as PostgresJsDatabase);
  return patcher.applyPatch({
    runId,
    dagVersion,
    mutations,
    appliedBy,
    reason,
  });
}

// ── Re-export detectCycle for consumers that need standalone cycle checking ──

// detectCycle is used internally via validateDag, but we re-export the
// adjacency builder for callers that need a raw cycle check.
export function buildAdjacency(
  nodes: V3Node[],
): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) {
    const deps = "deps" in node ? (node as any).deps : undefined;
    adjacency.set(node.id, Array.isArray(deps) ? deps : []);
  }
  return adjacency;
}

export function hasCycle(nodes: V3Node[]): string | null {
  const adjacency = buildAdjacency(nodes);
  return detectCycle(adjacency);
}
