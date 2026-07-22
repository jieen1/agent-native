import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { parseModelList } from "../shared/model-list.js";

export default defineAction({
  description: "List saved model runtimes (vLLM / Claude Code).",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) return [];
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.runtimeConfigs)
      .where(eq(schema.runtimeConfigs.ownerEmail, ownerEmail))
      .orderBy(desc(schema.runtimeConfigs.updatedAt));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      baseUrl: r.baseUrl,
      model: r.model,
      // Parse the additive `models` JSON list (DESIGN §8.3 item4). A malformed
      // value degrades to [] rather than failing the whole list read.
      models: parseModelList(r.models),
      // `active` is physically bigint in Postgres; postgres.js returns bigint
      // columns as strings, so a bare `=== 1` never matches in production
      // (see routing-runtime-executor.ts's `normalizeActive` for the full
      // root-cause writeup, 2026-07-22). Normalize before comparing.
      active: Number(r.active) === 1,
    }));
  },
});
