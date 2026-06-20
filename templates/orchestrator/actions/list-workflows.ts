import { defineAction } from "@agent-native/core";
import { accessFilter } from "@agent-native/core/sharing";
import { and, desc, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { parseSteps } from "../shared/types.js";

export default defineAction({
  description: "List workflows, newest first.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.workflows)
      .where(
        and(
          accessFilter(schema.workflows, schema.workflowShares),
          isNull(schema.workflows.deletedAt),
        ),
      )
      .orderBy(desc(schema.workflows.updatedAt));

    return rows.map((wf) => ({
      id: wf.id,
      name: wf.name,
      description: wf.description,
      stepCount: parseSteps(wf.steps).length,
      createdAt: wf.createdAt,
      updatedAt: wf.updatedAt,
    }));
  },
});
