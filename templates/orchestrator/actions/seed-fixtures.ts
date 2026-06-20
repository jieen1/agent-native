import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { newId, nowIso } from "./_util.js";
import { validateGraph } from "../shared/types.js";
import { FIXTURES } from "../server/engine/fixtures.js";

// Install (or refresh) the six P1 control-flow fixture templates so each can be
// driven headlessly via run-start. Idempotent: re-running updates the graph of
// the existing fixture (matched by name) rather than duplicating it.
export default defineAction({
  description:
    "Seed the six P1 control-flow fixture templates (sequential, pipeline, parallel, fanout, branch, loop-until-dry). Returns { fixtures: { <key>: templateId } }.",
  schema: z.object({
    only: z.string().optional().describe("Seed only this fixture key."),
  }),
  run: async (args) => {
    const ownerEmail = getRequestUserEmail() ?? "local@localhost";
    const orgId = getRequestOrgId();
    const db = getDb();
    const out: Record<string, string> = {};

    const keys = args.only ? [args.only] : Object.keys(FIXTURES);
    for (const key of keys) {
      const fx = FIXTURES[key];
      if (!fx) throw new Error(`Unknown fixture: ${key}`);
      const result = validateGraph(fx.graph);
      if (!result.ok) {
        throw new Error(
          `Fixture ${key} is invalid: ${result.errors.join("; ")}`,
        );
      }
      const graphJson = JSON.stringify(fx.graph);
      const now = nowIso();

      const existing = await db
        .select({
          id: schema.workflowTemplates.id,
          version: schema.workflowTemplates.version,
        })
        .from(schema.workflowTemplates)
        .where(
          and(
            eq(schema.workflowTemplates.name, fx.name),
            eq(schema.workflowTemplates.ownerEmail, ownerEmail),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(schema.workflowTemplates)
          .set({
            description: fx.description,
            graph: graphJson,
            version: (existing[0].version ?? 1) + 1,
            updatedAt: now,
            // Re-seeding resurrects a previously soft-deleted fixture.
            deletedAt: null,
          })
          .where(eq(schema.workflowTemplates.id, existing[0].id));
        out[key] = existing[0].id;
      } else {
        const id = newId("tpl");
        await db.insert(schema.workflowTemplates).values({
          id,
          name: fx.name,
          description: fx.description,
          graph: graphJson,
          version: 1,
          createdAt: now,
          updatedAt: now,
          ownerEmail,
          orgId,
          visibility: "private",
        });
        out[key] = id;
      }
    }
    return { fixtures: out };
  },
});
