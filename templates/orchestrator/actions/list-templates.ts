import { defineAction } from "@agent-native/core";
import { accessFilter } from "@agent-native/core/sharing";
import { and, desc, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { parseGraph } from "../shared/types.js";

export default defineAction({
  description: "List v2 workflow templates, newest first.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.workflowTemplates)
      .where(
        and(
          accessFilter(schema.workflowTemplates, schema.workflowTemplateShares),
          isNull(schema.workflowTemplates.deletedAt),
        ),
      )
      .orderBy(desc(schema.workflowTemplates.updatedAt));
    return rows.map((t) => {
      const g = parseGraph(t.graph);
      return {
        id: t.id,
        name: t.name,
        description: t.description,
        version: t.version,
        nodeCount: g.nodes.length,
        edgeCount: g.edges.length,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      };
    });
  },
});
