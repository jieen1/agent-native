import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { eq, and, asc } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

export default defineAction({
  description:
    "List all sprint artifacts for a sprint, grouped by docKey. " +
    "Each group contains all versions in ascending order so callers can render " +
    "the full version chain (latest = last item in the array).",
  schema: z.object({ sprintId: z.string().min(1) }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

    const db = getDb();
    const rows = await db
      .select()
      .from(schema.sprintArtifacts)
      .where(
        and(
          eq(schema.sprintArtifacts.sprintId, args.sprintId),
          ownerScope(schema.sprintArtifacts),
        ),
      )
      .orderBy(asc(schema.sprintArtifacts.version));

    // Group by docKey; versions are already in ascending order from the query
    const byDocKey: Record<string, typeof rows> = {};
    for (const r of rows) {
      if (!byDocKey[r.docKey]) byDocKey[r.docKey] = [];
      byDocKey[r.docKey].push(r);
    }

    return { byDocKey };
  },
});
