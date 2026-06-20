import { defineAction } from "@agent-native/core";
import { accessFilter } from "@agent-native/core/sharing";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { parseProjectSchemes } from "../server/work-items/schemes.js";
import { DEFAULT_ENVIRONMENTS } from "../shared/types.js";

// list-project-schemes — the all-projects Board reads this in ONE call to derive
// per-type kanban columns for every project the user can see (FRONTEND §2). It
// returns each project's resolved scheme set (override merged onto the defaults)
// + environments, so the board does not need N get-project round-trips. Owner-
// scoped via accessFilter; read-only (auto GET + MCP).
export default defineAction({
  description:
    "List every visible project's resolved status-scheme set + environments, keyed by project id — the board reads this to derive per-type columns in one call.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
    const db = getDb();
    const rows = await db
      .select({
        id: schema.projects.id,
        key: schema.projects.key,
        statusSchemes: schema.projects.statusSchemes,
        environments: schema.projects.environments,
      })
      .from(schema.projects)
      .where(accessFilter(schema.projects, schema.projectShares));

    return rows.map((p) => {
      let environments: string[] = DEFAULT_ENVIRONMENTS;
      if (typeof p.environments === "string" && p.environments) {
        try {
          const parsed = JSON.parse(p.environments);
          if (Array.isArray(parsed)) environments = parsed.map(String);
        } catch {
          // fall back to defaults on bad JSON
        }
      }
      return {
        id: p.id,
        key: p.key,
        environments,
        schemes: parseProjectSchemes(p.statusSchemes),
      };
    });
  },
});
