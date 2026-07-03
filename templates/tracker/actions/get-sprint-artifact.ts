import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

export default defineAction({
  description: "Get a single sprint artifact by id, including the full markdown content.",
  schema: z.object({ id: z.string().min(1) }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

    const db = getDb();
    const row = (
      await db
        .select()
        .from(schema.sprintArtifacts)
        .where(
          and(
            eq(schema.sprintArtifacts.id, args.id),
            ownerScope(schema.sprintArtifacts),
          ),
        )
        .limit(1)
    )[0];

    if (!row) throw new Error("Sprint artifact not found");
    return row;
  },
});
