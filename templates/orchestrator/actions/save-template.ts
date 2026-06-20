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

// Create (no id) or update (id given) a v2 workflow template. Validates the
// graph via the ONE shared `validateGraph` (REJECT on errors — DESIGN §3/§6.3)
// and bumps `version` on update. Stores the normalized graph JSON.
export default defineAction({
  description:
    "Create or update a v2 workflow template (a graph of typed nodes + edges). Pass `id` to update; validates via validateGraph and rejects an invalid graph.",
  schema: z.object({
    id: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
    graph: z
      .union([z.string(), z.record(z.string(), z.unknown())])
      .describe("WorkflowGraph or JSON string of the same"),
  }),
  run: async (args) => {
    const graph = parseGraph(
      typeof args.graph === "string" ? args.graph : JSON.stringify(args.graph),
    );
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
      return { id: args.id, ok: true, warnings: result.warnings };
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
    return { id, ok: true, warnings: result.warnings };
  },
});
