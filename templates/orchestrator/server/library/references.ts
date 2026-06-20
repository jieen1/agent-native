// Find which workflow templates reference a node-library entry (DESIGN §3.7).
// A graph references a library node by `nodeDefKey`. delete-node-def BLOCKS a
// delete when any template's graph references the key, and lists the referencing
// templates so the user knows what to update first.

import { and, isNull } from "drizzle-orm";
import { accessFilter } from "@agent-native/core/sharing";
import { getDb, schema } from "../db/index.js";
import { parseGraph } from "../../shared/types.js";

/** One template that references a node-def key. */
export interface NodeDefReference {
  templateId: string;
  templateName: string;
  /** The node ids in that template that carry this nodeDefKey. */
  nodeIds: string[];
}

/**
 * Scan every (non-deleted, accessible) workflow template's graph for nodes whose
 * `nodeDefKey` equals `key`. Returns one entry per referencing template. Empty
 * when nothing references the key (safe to delete).
 */
export async function findTemplatesReferencingNodeDef(
  key: string,
): Promise<NodeDefReference[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: schema.workflowTemplates.id,
      name: schema.workflowTemplates.name,
      graph: schema.workflowTemplates.graph,
    })
    .from(schema.workflowTemplates)
    .where(
      and(
        accessFilter(schema.workflowTemplates, schema.workflowTemplateShares),
        isNull(schema.workflowTemplates.deletedAt),
      ),
    );

  const refs: NodeDefReference[] = [];
  for (const row of rows) {
    const graph = parseGraph(row.graph);
    const nodeIds = graph.nodes
      .filter((n) => n.nodeDefKey === key)
      .map((n) => n.id);
    if (nodeIds.length > 0) {
      refs.push({ templateId: row.id, templateName: row.name, nodeIds });
    }
  }
  return refs;
}
