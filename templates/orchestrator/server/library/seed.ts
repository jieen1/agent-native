// Seed the starter node library + the bundled template (DESIGN §3.7 / §1.9).
// Pure DB logic (no request-context) so both the seed-library action and tests
// call it with an explicit owner. Idempotent: node_defs matched by (key, owner),
// the bundled template matched by (name, owner) — re-running UPDATES rather than
// duplicating.

import { and, eq } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";
import { newId, nowIso } from "../../actions/_util.js";
import { validateGraph } from "../../shared/types.js";
import {
  BUNDLED_TEMPLATE_NAME,
  STARTER_LIBRARY,
  buildBundledTemplateGraph,
} from "../../shared/library.js";

type Db = ReturnType<typeof getDb>;

export interface SeedLibraryResult {
  /** key → node_defs.id for every seeded starter entry. */
  nodeDefs: Record<string, string>;
  /** The bundled template's id. */
  bundledTemplateId: string;
  /** The starter keys, in order. */
  keys: string[];
}

/**
 * Seed (or refresh) the starter library + bundled template for an owner.
 * Idempotent. Returns the ids so the caller / test can assert the round-trip.
 */
export async function seedStarterLibrary(
  db: Db,
  ownerEmail: string,
  orgId: string | null,
): Promise<SeedLibraryResult> {
  const now = nowIso();
  const nodeDefs: Record<string, string> = {};

  for (const def of STARTER_LIBRARY) {
    const configJson = JSON.stringify(def.config);
    const existing = await db
      .select({ id: schema.nodeDefs.id })
      .from(schema.nodeDefs)
      .where(
        and(
          eq(schema.nodeDefs.key, def.key),
          eq(schema.nodeDefs.ownerEmail, ownerEmail),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(schema.nodeDefs)
        .set({
          kind: def.kind,
          title: def.title,
          config: configJson,
          version: def.version,
          updatedAt: now,
        })
        .where(eq(schema.nodeDefs.id, existing[0].id));
      nodeDefs[def.key] = existing[0].id;
    } else {
      const id = newId("nd");
      await db.insert(schema.nodeDefs).values({
        id,
        key: def.key,
        kind: def.kind,
        title: def.title,
        config: configJson,
        version: def.version,
        createdAt: now,
        updatedAt: now,
        ownerEmail,
        orgId,
        visibility: "private",
      });
      nodeDefs[def.key] = id;
    }
  }

  // The bundled template (DESIGN §1.9). Its graph ends with the vetted library
  // tail incl. the finalize-status gate, so it must validate.
  const graph = buildBundledTemplateGraph();
  const validation = validateGraph(graph);
  if (!validation.ok) {
    throw new Error(
      `bundled template '${BUNDLED_TEMPLATE_NAME}' is invalid: ${validation.errors.join("; ")}`,
    );
  }
  const graphJson = JSON.stringify(graph);

  const existingTpl = await db
    .select({
      id: schema.workflowTemplates.id,
      version: schema.workflowTemplates.version,
    })
    .from(schema.workflowTemplates)
    .where(
      and(
        eq(schema.workflowTemplates.name, BUNDLED_TEMPLATE_NAME),
        eq(schema.workflowTemplates.ownerEmail, ownerEmail),
      ),
    )
    .limit(1);

  let bundledTemplateId: string;
  if (existingTpl.length > 0) {
    await db
      .update(schema.workflowTemplates)
      .set({
        description:
          "Bundled: implement → diverse-lens review panel → vetted tail (run-tests → finalize-status → git-commit → git-push → open-pr). DESIGN §1.9/§3.7.",
        graph: graphJson,
        version: (existingTpl[0].version ?? 1) + 1,
        updatedAt: now,
        deletedAt: null,
      })
      .where(eq(schema.workflowTemplates.id, existingTpl[0].id));
    bundledTemplateId = existingTpl[0].id;
  } else {
    const id = newId("tpl");
    await db.insert(schema.workflowTemplates).values({
      id,
      name: BUNDLED_TEMPLATE_NAME,
      description:
        "Bundled: implement → diverse-lens review panel → vetted tail (run-tests → finalize-status → git-commit → git-push → open-pr). DESIGN §1.9/§3.7.",
      graph: graphJson,
      version: 1,
      createdAt: now,
      updatedAt: now,
      ownerEmail,
      orgId,
      visibility: "private",
    });
    bundledTemplateId = id;
  }

  return {
    nodeDefs,
    bundledTemplateId,
    keys: STARTER_LIBRARY.map((d) => d.key),
  };
}
