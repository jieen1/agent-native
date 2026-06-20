import { defineAction } from "@agent-native/core";
import { accessFilter } from "@agent-native/core/sharing";
import { desc } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";

// List projects the caller can see (owner-scoped via accessFilter), newest
// first. Read-only; auto GET + MCP.
export default defineAction({
  description: "List projects, newest first.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.projects)
      .where(accessFilter(schema.projects, schema.projectShares))
      .orderBy(desc(schema.projects.updatedAt));
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      key: p.key,
      description: p.description,
      workingDir: p.workingDir,
      gitRemote: p.gitRemote,
      defaultBranch: p.defaultBranch,
      defaultWorkflowId: p.defaultWorkflowId,
      hasRepo: !!p.gitRemote,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));
  },
});
