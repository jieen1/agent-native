import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { resolveAccess } from "@agent-native/core/sharing";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { newId, nowIso } from "./_util.js";
import { parseGraph, validateGraph } from "../shared/types.js";
import { injectFinalizeStatusGate } from "../shared/finalize-gate.js";

// Create (no id) or update (id given) a v2 workflow template. Validates the
// graph via the ONE shared `validateGraph` (REJECT on errors — DESIGN §3/§6.3),
// AUTO-INJECTS the required finalize-status gate before `end` for delivery graphs
// (DESIGN §6.2b L1 — the brain cannot omit it, like a git-push gate), and bumps
// `version` on update. Stores the normalized graph JSON.
export default defineAction({
  description:
    "Create or update a v2 workflow template (a graph of typed nodes + edges). Pass `id` to update; validates via validateGraph and rejects an invalid graph; auto-injects the finalize-status gate before `end` for delivery graphs.",
  schema: z.object({
    id: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
    graph: z
      .union([z.string(), z.record(z.string(), z.unknown())])
      .describe("WorkflowGraph or JSON string of the same"),
    /**
     * Skip the finalize-status auto-injection. Used for non-delivery utility
     * templates (e.g. the P1 control-flow fixtures) where a business-status gate
     * is meaningless. Default false: delivery graphs always get the gate.
     */
    skipFinalizeGate: z.coerce.boolean().optional(),
  }),
  run: async (args) => {
    const parsed = parseGraph(
      typeof args.graph === "string" ? args.graph : JSON.stringify(args.graph),
    );

    // finalize-status GATE (DESIGN §6.2b L1): auto-inject before `end` for
    // delivery graphs unless explicitly skipped. injectFinalizeStatusGate is a
    // no-op for non-delivery graphs (no body, not exactly one start+end) and for
    // graphs that already have the gate.
    const injection = args.skipFinalizeGate
      ? { graph: parsed, injected: false }
      : injectFinalizeStatusGate(parsed);
    const graph = injection.graph;

    const result = validateGraph(graph);
    if (!result.ok) {
      throw new Error(`Invalid template graph: ${result.errors.join("; ")}`);
    }

    const db = getDb();
    const now = nowIso();
    const graphJson = JSON.stringify(graph);

    if (args.id) {
      const access = await resolveAccess("workflow_template", args.id);
      if (!access) throw new Error(`Template ${args.id} not found`);
      if (access.role === "viewer") throw new Error("Read-only access");
      const current = access.resource as { version?: number };
      await db
        .update(schema.workflowTemplates)
        .set({
          name: args.name,
          description: args.description ?? "",
          graph: graphJson,
          version: (current.version ?? 1) + 1,
          updatedAt: now,
        })
        .where(eq(schema.workflowTemplates.id, args.id));
      return {
        id: args.id,
        ok: true,
        warnings: result.warnings,
        finalizeGateInjected: injection.injected,
      };
    }

    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId();
    const id = newId("tpl");
    await db.insert(schema.workflowTemplates).values({
      id,
      name: args.name,
      description: args.description ?? "",
      graph: graphJson,
      version: 1,
      createdAt: now,
      updatedAt: now,
      ownerEmail,
      orgId,
      visibility: "private",
    });
    return {
      id,
      ok: true,
      warnings: result.warnings,
      finalizeGateInjected: injection.injected,
    };
  },
});
