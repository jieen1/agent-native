// V3 Patch System (DESIGN §8.6, IMPLEMENTATION P2 §A)
//
// CAS-protected mid-run DAG mutation.  Supports five mutation types:
// modify_node, add_node, remove_node, modify_loop, replace_dag.
// Every patch is validated (structural + acyclic) before it touches the run.

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

// ── Mutation types ───────────────────────────────────────────────────────────

/** Modify an existing node's prompt and/or model_override. */
interface ModifyNodeMutation {
  kind: "modify_node";
  nodeIdInDag: string;
  prompt?: string;
  model_override?: string;
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

/** Modify a loop node's max_iterations and/or until expression. */
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
      error: "version_conflict" | "validation_failed" | "removal_blocked" | string;
      currentDagVersion?: number;
      errors?: string[];
    };

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
   * applied.  A CAS check on `dag_version` prevents concurrent patch conflicts.
   */
  public async applyPatch(params: ApplyPatchParams): Promise<ApplyPatchResult> {
    const { runId, dagVersion, mutations, appliedBy, reason } = params;

    // 1. Read current run row
    const [run] = await this.db
      .select()
      .from(v3Runs)
      .where(eq(v3Runs.id, runId));

    if (!run) {
      return { success: false, error: `Run ${runId} not found` };
    }

    // 2. CAS check — dag_version must match
    if (run.dagVersion !== dagVersion) {
      return {
        success: false,
        error: "version_conflict",
        currentDagVersion: run.dagVersion,
      };
    }

    // 3. Parse current DAG
    const currentDag = this.parseDag(run.dag);
    if (!currentDag) {
      return { success: false, error: "Failed to parse current DAG" };
    }

    // 4. Read current node rows (needed for remove_node constraint)
    const nodeRows = await this.db
      .select()
      .from(v3Nodes)
      .where(eq(v3Nodes.runId, runId));

    // 5. Apply mutations to a DAG snapshot
    const newDag = structuredClone(currentDag);
    const applyResult = this.applyMutations(newDag, mutations, nodeRows);
    if (!applyResult.ok) {
      return {
        success: false,
        error: applyResult.error,
        errors: applyResult.errors,
      };
    }

    // 6. Validate resulting DAG via validateDag()
    const validation = validateDag(newDag);
    if (!validation.ok) {
      return {
        success: false,
        error: "validation_failed",
        errors: validation.errors,
      };
    }

    // 7. Write v3_patches row + update v3_runs atomically via raw SQL
    const newVersion = run.dagVersion + 1;
    const id = patchId();
    const now = new Date();

    await this.db.transaction(async (tx) => {
      // Insert patch record
      await tx.insert(v3Patches).values({
        id,
        runId,
        dagVersionBefore: run.dagVersion,
        dagVersionAfter: newVersion,
        patchOps: mutations,
        actor: appliedBy,
        reason: reason ?? null,
        applied: 1,
        appliedAt: now,
        ownerEmail: "local@localhost",
        orgId: null,
      });

      // Update run DAG + version
      await tx
        .update(v3Runs)
        .set({
          dag: newDag,
          dagVersion: newVersion,
        })
        .where(and(eq(v3Runs.id, runId), eq(v3Runs.dagVersion, dagVersion)));
    });

    return { success: true, newDagVersion: newVersion, patchId: id };
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
    | { ok: false; error: string; errors?: string[]; currentDagVersion?: number } {
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
  ): { ok: true } | { ok: false; error: string; errors?: string[] } {
    switch (mutation.kind) {
      case "modify_node":
        return this.applyModifyNode(dag, mutation);
      case "add_node":
        return this.applyAddNode(dag, mutation);
      case "remove_node":
        return this.applyRemoveNode(dag, mutation, nodeRows);
      case "modify_loop":
        return this.applyModifyLoop(dag, mutation);
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
   * modify_node — change prompt and/or model_override on the matching node.
   * Only agent nodes have prompt/model_override.
   */
  private applyModifyNode(
    dag: V3Dag,
    mutation: ModifyNodeMutation,
  ): { ok: true } | { ok: false; error: string } {
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

    const agentNode = node as V3AgentNode;
    if (mutation.prompt !== undefined) {
      agentNode.prompt = mutation.prompt;
    }
    if (mutation.model_override !== undefined) {
      agentNode.model_override = mutation.model_override;
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
   */
  private applyModifyLoop(
    dag: V3Dag,
    mutation: ModifyLoopMutation,
  ): { ok: true } | { ok: false; error: string } {
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
