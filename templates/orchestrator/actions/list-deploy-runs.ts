import { defineAction } from "@agent-native/core";
import { desc } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";

function parseJsonStrings(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

// Deploy history for the settings page (shared operator state — see
// server/db/schema.ts's deployRuns comment for why this has no
// ownableColumns()/accessFilter scoping).
export default defineAction({
  description:
    "List recent deploy runs (backup/build/restart/verify attempts), newest first.",
  schema: z.object({
    limit: z.number().int().min(1).max(50).optional().default(10),
  }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.deployRuns)
      .orderBy(desc(schema.deployRuns.createdAt))
      .limit(args.limit);
    return rows.map((row) => ({
      id: row.id,
      target: row.target,
      apps: parseJsonStrings(row.apps),
      status: row.status,
      stage: row.stage,
      commitSha: row.commitSha,
      error: row.error,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      createdAt: row.createdAt,
      triggeredBy: row.triggeredBy,
    }));
  },
});
