import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import {
  validateDependencyGraph,
  type GraphEdge,
  type GraphNode,
} from "../shared/graph-validation.js";

export default defineAction({
  description:
    "Validate the 'blocked-by' dependency graph for all work items in an " +
    "epic (project) or a sprint: self-dependency, cycles, chain depth, lack " +
    "of parallelism, and orphan nodes. Purely deterministic — no LLM calls.",
  schema: z.object({
    scope: z.enum(["epic", "sprint"]).describe("'epic' scopes by project, 'sprint' scopes by sprint"),
    id: z.string().min(1).describe("The projectId (scope=epic) or sprintId (scope=sprint)"),
  }),
  http: { method: "GET" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

    const db = getDb();

    const scopeFilter =
      args.scope === "epic"
        ? eq(schema.workItems.projectId, args.id)
        : eq(schema.workItems.sprintId, args.id);

    const items = (await db
      .select({ id: schema.workItems.id, itemKey: schema.workItems.itemKey })
      .from(schema.workItems)
      .where(and(ownerScope(schema.workItems), scopeFilter))
      .limit(2000)) as { id: string; itemKey: string }[];

    const nodes: GraphNode[] = items.map((it) => ({
      id: it.id,
      itemKey: it.itemKey || it.id,
    }));

    let edges: GraphEdge[] = [];
    if (nodes.length > 0) {
      const ids = nodes.map((n) => n.id);
      const links = (await db
        .select({
          fromItemId: schema.links.fromItemId,
          toItemId: schema.links.toItemId,
          linkType: schema.links.linkType,
        })
        .from(schema.links)
        .where(
          and(
            ownerScope(schema.links),
            eq(schema.links.linkType, "blocked-by"),
            inArray(schema.links.fromItemId, ids),
            inArray(schema.links.toItemId, ids),
          ),
        )
        .limit(5000)) as { fromItemId: string; toItemId: string; linkType: string }[];

      // "A blocked-by B" means A depends on B — the validator's edge
      // direction (fromId depends on toId) matches the link as stored.
      edges = links.map((l) => ({ fromId: l.fromItemId, toId: l.toItemId }));
    }

    return validateDependencyGraph(nodes, edges);
  },
});
