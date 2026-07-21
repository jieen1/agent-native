// V3 workflow.patch action (DESIGN §8.6, G3).
//
// Exposes live DAG mutation to the agent via MCP.  Delegates to applyPatch()
// in server/engine/v3-patcher.ts.  After a successful patch the reconciler is
// re-ticked so the new plan takes effect immediately.
//
// Ops use the "op" key (design surface) which this action normalises to "kind"
// before passing to V3Patcher.  All five mutation types are supported:
//   modify_node, add_node, remove_node, modify_loop, replace_dag.

import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getV3Db, v3Schema, resolveOwnerEmail } from "../server/db/index.js";
import { V3Patcher } from "../server/engine/v3-patcher.js";
import type { DagMutation } from "../server/engine/v3-patcher.js";
import { triggerTickSafe } from "../server/plugins/v3-reconciler.js";

// ── Op schemas ───────────────────────────────────────────────────────────────

const modifyNodeOpSchema = z.object({
  op: z.literal("modify_node"),
  node_id: z.string(),
  set: z
    .object({
      prompt: z.string().optional(),
      model_override: z.string().optional(),
      guard: z.string().optional(),
      deps: z.array(z.string()).optional(),
    })
    .passthrough(),
});

const addNodeOpSchema = z.object({
  op: z.literal("add_node"),
  node: z.record(z.string(), z.unknown()),
});

const removeNodeOpSchema = z.object({
  op: z.literal("remove_node"),
  node_id: z.string(),
});

const modifyLoopOpSchema = z.object({
  op: z.literal("modify_loop"),
  node_id: z.string(),
  set: z
    .object({
      max_iterations: z.number().int().positive().optional(),
      until: z.string().optional(),
    })
    .passthrough(),
});

const replaceDagOpSchema = z.object({
  op: z.literal("replace_dag"),
  new_dag: z.record(z.string(), z.unknown()),
});

const patchOpSchema = z.union([
  modifyNodeOpSchema,
  addNodeOpSchema,
  removeNodeOpSchema,
  modifyLoopOpSchema,
  replaceDagOpSchema,
]);

// ── Op normaliser ────────────────────────────────────────────────────────────

/**
 * Translate a design-surface op (uses "op" + snake_case fields) into the
 * engine DagMutation type (uses "kind" + camelCase fields).
 */
function opToMutation(op: z.infer<typeof patchOpSchema>): DagMutation {
  switch (op.op) {
    case "modify_node":
      return {
        kind: "modify_node",
        nodeIdInDag: op.node_id,
        prompt: op.set.prompt,
        model_override: op.set.model_override,
        guard: op.set.guard,
        deps: op.set.deps,
      };

    case "add_node":
      // The node JSON is passed through as-is; V3Patcher validates the DAG.
      return {
        kind: "add_node",
        node: op.node as any,
      };

    case "remove_node":
      return {
        kind: "remove_node",
        nodeIdInDag: op.node_id,
      };

    case "modify_loop":
      return {
        kind: "modify_loop",
        nodeIdInDag: op.node_id,
        maxIterations: (op.set as any).max_iterations,
        until: (op.set as any).until,
      };

    case "replace_dag": {
      const rawNodes = (op.new_dag as any).nodes;
      return {
        kind: "replace_dag",
        nodes: Array.isArray(rawNodes) ? rawNodes : [],
      };
    }
  }
}

// ── Action ───────────────────────────────────────────────────────────────────

/**
 * Live DAG mutation — the "patch the future" headline capability (DESIGN §8.6).
 *
 * Applies a batch of patch ops to a running V3 run.  Uses CAS via
 * expected_dag_version to prevent concurrent mutation races.  On success the
 * reconciler is re-ticked so the patched plan takes effect on the next pass.
 */
export const workflowPatch = defineAction({
  description:
    "Apply live DAG mutations to a running V3 run (DESIGN §8.6). " +
    "Supports modify_node, add_node, remove_node, modify_loop, replace_dag. " +
    "Uses CAS via expected_dag_version. Returns new_dag_version on success or an error.",
  schema: z.object({
    runId: z.string(),
    expected_dag_version: z.number().int().positive(),
    ops: z.array(patchOpSchema).min(1),
    reason: z.string().optional(),
  }),
  run: async (args) => {
    const db = getV3Db();
    const patcher = new V3Patcher(db as any);

    // Fail-closed owner scope — only the run's owner may mutate its live DAG.
    // Without this, any caller could patch another owner's running run by id.
    const [ownedRun] = await db
      .select({ id: v3Schema.v3Runs.id })
      .from(v3Schema.v3Runs)
      .where(
        and(
          eq(v3Schema.v3Runs.id, args.runId),
          eq(v3Schema.v3Runs.ownerEmail, resolveOwnerEmail()),
        ),
      )
      .limit(1);
    if (!ownedRun) throw new Error(`Run '${args.runId}' not found`);

    const actorEmail = getRequestUserEmail() ?? "system";

    const mutations: DagMutation[] = args.ops.map(opToMutation);

    const result = await patcher.applyPatch({
      runId: args.runId,
      dagVersion: args.expected_dag_version,
      mutations,
      appliedBy: actorEmail,
      reason: args.reason,
    });

    if (result.success) {
      // G1: Re-tick so the reconciler processes the patched DAG immediately.
      triggerTickSafe(args.runId).catch(() => {});
      return {
        ok: true,
        new_dag_version: result.newDagVersion,
        patch_id: result.patchId,
      };
    }

    // Return structured error (mirrors DESIGN §8.6 error shapes).
    return {
      ok: false,
      error: result.error,
      current_dag_version: result.currentDagVersion,
      node_id: result.nodeId,
      node_status: result.nodeStatus,
      errors: result.errors,
    };
  },
});
