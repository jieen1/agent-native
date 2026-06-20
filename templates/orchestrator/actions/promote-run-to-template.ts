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
import { distillRun } from "../server/engine/promote.js";

// promote-run-to-template (DESIGN §6.5): distill a run's ACTUAL executed graph
// into a NEW reusable workflow_template. Dynamic fanout indices collapse back to
// a single fanout node; the node/edge set matches the execution topology, so a
// re-run reaches the same shape without dynamic expansion (besides genuine
// fanout). In P1 there is no dynamic-authoring brain yet, so the distilled graph
// equals the source template's static shape — this action ships the distill
// logic + validation now and P3 feeds it real dynamically-authored runs.
export default defineAction({
  description:
    "Promote a workflow run into a new reusable template by distilling its executed graph (collapses dynamic fanout indices to a single node).",
  schema: z.object({
    runId: z.string(),
    name: z.string().optional().describe("Name for the distilled template."),
  }),
  run: async (args) => {
    const access = await resolveAccess("workflow_run", args.runId);
    if (!access) throw new Error(`Run ${args.runId} not found`);
    if (access.role === "viewer") throw new Error("Read-only access");
    const run = access.resource as Record<string, unknown>;

    const db = getDb();

    // Load the source template the run instantiated (authored config source).
    const tplRows = await db
      .select()
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, String(run.templateId)))
      .limit(1);
    const sourceTpl = tplRows[0];
    if (!sourceTpl) {
      throw new Error(`Template ${String(run.templateId)} not found for run`);
    }
    const sourceGraph = parseGraph(sourceTpl.graph);

    // Load the run's ACTUAL executed NodeRuns (the execution topology).
    const nodeRuns = await db
      .select()
      .from(schema.nodeRuns)
      .where(eq(schema.nodeRuns.runId, args.runId));
    if (nodeRuns.length === 0) {
      throw new Error(`Run ${args.runId} has no NodeRuns to distill`);
    }

    const distilled = distillRun(
      sourceGraph,
      nodeRuns.map((nr) => ({
        nodeId: nr.nodeId,
        type: nr.type,
        title: nr.title,
        assignee: nr.assignee,
        engine: nr.engine,
        model: nr.model,
        iteration: nr.iteration,
        fanoutIndex: nr.fanoutIndex,
        dynamic: nr.dynamic,
      })),
    );

    // The distilled graph must itself be a valid authored template (§6.3).
    const result = validateGraph(distilled.graph);
    if (!result.ok) {
      throw new Error(
        `Distilled template is invalid: ${result.errors.join("; ")}`,
      );
    }

    const ownerEmail = getRequestUserEmail() ?? "local@localhost";
    const orgId = getRequestOrgId();
    const id = newId("tpl");
    const now = nowIso();
    const name =
      args.name ?? `${String(sourceTpl.name)} (promoted ${now.slice(0, 10)})`;

    await db.insert(schema.workflowTemplates).values({
      id,
      name,
      description: `Distilled from run ${args.runId} (DESIGN §6.5).`,
      graph: JSON.stringify(distilled.graph),
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
      sourceRunId: args.runId,
      sourceTemplateId: String(run.templateId),
      nodeIds: distilled.nodeIds,
      collapsed: distilled.collapsed,
      warnings: result.warnings,
    };
  },
});
