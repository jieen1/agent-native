import { and, desc, eq } from "drizzle-orm";

import { newId } from "../../actions/_util.js";
import { getV3Db, v3Schema, LOCAL_DEFAULT_OWNER } from "../db/index.js";
import { WORKFLOW_LIBRARY_SEED } from "../engine/workflow-library-seed.js";

/**
 * Boot-time seed for the 9 built-in workflow templates (04-orchestrator.md
 * §4/§13 — "种子：九套工作流模板...首启 upsert，带 内置 标"). Modeled on
 * `agent-defs-seed.ts`'s best-effort, non-fatal boot pattern.
 *
 * Two real-world cases, both handled:
 *  1. The name has never been saved — insert a fresh version-1 row with the
 *     seed's dag/description/inputSchema and `meta.builtin: true`.
 *  2. The name ALREADY exists (the live 101 DB has 6 dogfood-authored
 *     templates that happen to share some of these names) — the dag/version
 *     history is real user/brain work and must NOT be touched or
 *     re-versioned. Only the LATEST version's `meta` is patched (merged, not
 *     replaced) so builtin/tags/family metadata appears without discarding
 *     whatever changeNote or other meta keys a later hand-save already wrote.
 *
 * Both paths are idempotent — safe to run on every boot.
 *
 * Ordering: Nitro loads `server/plugins/*` alphabetically, so this file's
 * name (`workflow-templates-seed.ts`, "w") sorts AFTER `db.ts` ("d") — the
 * `meta` column this plugin reads/writes (`s8-workflow-library` migration)
 * is guaranteed to exist by the time this runs. If a select/insert here ever
 * throws because the column is missing (e.g. a future refactor changes plugin
 * load order), the outer try/catch swallows it for that boot only — the next
 * restart re-attempts seeding from scratch, so no template silently stays
 * unseeded forever.
 */
export default async function workflowTemplatesSeedPlugin(): Promise<void> {
  try {
    const db = getV3Db();
    let inserted = 0;
    let tagged = 0;
    for (const entry of WORKFLOW_LIBRARY_SEED) {
      const existing = await db
        .select({
          id: v3Schema.v3WorkflowTemplates.id,
          version: v3Schema.v3WorkflowTemplates.version,
          meta: v3Schema.v3WorkflowTemplates.meta,
        })
        .from(v3Schema.v3WorkflowTemplates)
        .where(eq(v3Schema.v3WorkflowTemplates.name, entry.name))
        .orderBy(desc(v3Schema.v3WorkflowTemplates.version))
        .limit(1);

      if (existing.length === 0) {
        await db.insert(v3Schema.v3WorkflowTemplates).values({
          id: newId("v3wf"),
          name: entry.name,
          version: 1,
          description: entry.description,
          dag: entry.dag,
          inputSchema: entry.inputSchema,
          meta: {
            builtin: true,
            family: entry.family,
            tags: entry.tags,
            changeNote: entry.changeNote,
          },
          ownerEmail: LOCAL_DEFAULT_OWNER,
          orgId: null,
        });
        inserted++;
        continue;
      }

      const row = existing[0];
      const prevMeta = (row.meta ?? {}) as Record<string, unknown>;
      if (prevMeta.builtin === true) continue; // already tagged — no-op

      // Tagging a PRE-EXISTING version (real dogfood/user history) — merge in
      // only the classification fields (builtin/family/tags). Deliberately
      // omit `changeNote`: this version's dag/description were NOT authored
      // by this seed, so stamping our canned "初始种子版本导入…" blurb onto it
      // would misrepresent real history as a seed import. Any existing
      // `changeNote` this row already had (there wasn't one pre-S8) is left
      // untouched via the `...prevMeta` spread.
      await db
        .update(v3Schema.v3WorkflowTemplates)
        .set({
          meta: {
            ...prevMeta,
            builtin: true,
            family: entry.family,
            tags: entry.tags,
          },
        })
        .where(
          and(
            eq(v3Schema.v3WorkflowTemplates.name, entry.name),
            eq(v3Schema.v3WorkflowTemplates.version, row.version),
          ),
        );
      tagged++;
    }
    console.log(
      `[workflow-templates-seed] inserted ${inserted}, tagged ${tagged} (of ${WORKFLOW_LIBRARY_SEED.length} seed entries)`,
    );
  } catch (err) {
    // best-effort seed; DB not ready yet (or mid-migration) is not fatal at boot
    console.warn(
      `[workflow-templates-seed] seed failed (non-fatal):`,
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
  }
}
