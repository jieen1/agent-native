import { defineAction } from "@agent-native/core";
import { accessFilter } from "@agent-native/core/sharing";
import { desc } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";

// List the node library (DESIGN §3.7 / §9 `node_defs`), newest first. The
// editor palette's Library tab reads this; the orchestrator brain reads it to
// reference vetted gates by `key`. Owner-scoped via accessFilter.
export default defineAction({
  description:
    "List reusable node-library entries (node_defs, DESIGN §3.7), newest first. Each entry has { id, key, kind, title, config (parsed), version }.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.nodeDefs)
      .where(accessFilter(schema.nodeDefs, schema.nodeDefShares))
      .orderBy(desc(schema.nodeDefs.updatedAt));
    return rows.map((n) => {
      let config: unknown = {};
      try {
        config = JSON.parse(n.config);
      } catch {
        config = {};
      }
      return {
        id: n.id,
        key: n.key,
        kind: n.kind,
        title: n.title,
        config,
        version: n.version,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
      };
    });
  },
});
