import { defineAction } from "@agent-native/core";
import { desc } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

export default defineAction({
  description: "List tracker projects the current user can see.",
  schema: z.object({}),
  http: { method: "GET" },
  run: async () => {
    const db = getDb();
    const rows = await db
      .select({
        id: schema.projects.id,
        key: schema.projects.key,
        name: schema.projects.name,
        description: schema.projects.description,
        gitRemote: schema.projects.gitRemote,
        defaultBranch: schema.projects.defaultBranch,
        stageGateConfig: schema.projects.stageGateConfig,
        createdAt: schema.projects.createdAt,
        updatedAt: schema.projects.updatedAt,
      })
      .from(schema.projects)
      .where(ownerScope(schema.projects))
      .orderBy(desc(schema.projects.updatedAt));
    return rows;
  },
});
