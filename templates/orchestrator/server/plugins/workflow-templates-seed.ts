import { and, desc, eq } from "drizzle-orm";

import { newId } from "../../actions/_util.js";
import { getV3Db, v3Schema, LOCAL_DEFAULT_OWNER } from "../db/index.js";
import { WORKFLOW_LIBRARY_SEED } from "../engine/workflow-library-seed.js";

/**
 * Boot-time seed for the built-in workflow templates (docs/sdlc-product-design/
 * r4-workflow-families-planning-skills.md §4.1 — the "撞名规则"). Modeled on
 * `agent-defs-seed.ts`'s best-effort, non-fatal boot pattern.
 *
 * Three real-world cases, all handled:
 *  1. The name has never been saved — insert a fresh version-1 row with the
 *     seed's dag/description/inputSchema and `meta.builtin: true`.
 *  2. The name ALREADY exists and its LATEST version's `dag` is structurally
 *     identical to this seed entry's own `dag` (e.g. re-running this boot
 *     plugin after a prior fresh insert of the same entry) — this row genuinely
 *     IS a seed-owned row. Patch `meta.builtin: true` as before.
 *  3. The name ALREADY exists but its LATEST version's `dag` does NOT match
 *     this seed entry's `dag` — real brain/user history this seed never wrote
 *     (r4 doc §1.2's proven example: `sdlc-promote`/`sdlc-issue-pipeline` both
 *     hit this path — a pre-existing brain-authored row, NOT this file's dag).
 *     The OLD code unconditionally stamped `meta.builtin: true` on such rows,
 *     which misrepresents a real brain/human template as seed-owned with no
 *     trace that the dag underneath was never written by this seed. Fixed:
 *     stamp `meta.metaTaggedOnly: true` instead (never `builtin`), and record
 *     the pre-patch `meta` snapshot into `changeNote` so the real prior state
 *     isn't lost. The library UI can use `metaTaggedOnly` to render a "血统
 *     混合" badge instead of presenting the row as a genuine built-in seed.
 *
 * In EVERY case the `dag` column itself is never written for a pre-existing
 * row, and no new version is ever inserted for an existing name — version
 * history is immutable ("已发生的错标不回改", r4 doc §4.1). Only the
 * builtin-vs-metaTaggedOnly classification (case 2 vs 3) is new; the "never
 * touch dag / never re-version" invariant is unchanged from before this fix.
 *
 * All three paths are idempotent — safe to run on every boot: case 2/3 rows
 * short-circuit via the `prevMeta.builtin`/`prevMeta.metaTaggedOnly` checks
 * below once already classified.
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
    let metaTaggedOnly = 0;
    for (const entry of WORKFLOW_LIBRARY_SEED) {
      const existing = await db
        .select({
          id: v3Schema.v3WorkflowTemplates.id,
          version: v3Schema.v3WorkflowTemplates.version,
          meta: v3Schema.v3WorkflowTemplates.meta,
          dag: v3Schema.v3WorkflowTemplates.dag,
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
      if (prevMeta.builtin === true || prevMeta.metaTaggedOnly === true) {
        continue; // already classified — no-op (idempotent across boots)
      }

      if (jsonDeepEqual(row.dag, entry.dag)) {
        // This version's dag IS what the seed itself would write — a
        // genuine seed-owned row (e.g. re-running this boot after a prior
        // fresh insert of the same entry). Normal builtin patch, same as
        // before this fix.
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
        continue;
      }

      // §4.1 撞名规则: this name's LATEST version already existed with a dag
      // this seed never wrote (real brain/user history). Never stamp
      // `builtin: true` on a dag we didn't author, and never touch/re-version
      // the `dag` column itself (version history is immutable — "已发生的
      // 错标不回改"). Mark with a DIFFERENT flag so the library UI can render
      // a "血统混合" badge instead of presenting this as a genuine built-in
      // seed row, and snapshot the pre-patch meta into `changeNote` so the
      // real prior state (whatever it was) isn't silently lost.
      await db
        .update(v3Schema.v3WorkflowTemplates)
        .set({
          meta: {
            ...prevMeta,
            metaTaggedOnly: true,
            family: entry.family,
            tags: entry.tags,
            changeNote: `撞名 meta-patch（此版本 dag 非本种子写入，历史 meta 快照：${JSON.stringify(prevMeta)}）`,
          },
        })
        .where(
          and(
            eq(v3Schema.v3WorkflowTemplates.name, entry.name),
            eq(v3Schema.v3WorkflowTemplates.version, row.version),
          ),
        );
      metaTaggedOnly++;
    }
    console.log(
      `[workflow-templates-seed] inserted ${inserted}, tagged ${tagged}, metaTaggedOnly ${metaTaggedOnly} (of ${WORKFLOW_LIBRARY_SEED.length} seed entries)`,
    );
  } catch (err) {
    // best-effort seed; DB not ready yet (or mid-migration) is not fatal at boot
    console.warn(
      `[workflow-templates-seed] seed failed (non-fatal):`,
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
  }
}

/**
 * Structural JSON equality, order-independent for object keys. Postgres
 * jsonb does NOT preserve object-key order on round-trip (documented
 * behavior, not a bug) — a naive `JSON.stringify(a) === JSON.stringify(b)`
 * comparison between a value just read back from jsonb and this file's own
 * object-literal `entry.dag` would false-negative on key order alone even
 * when the content is identical, which would misclassify genuine seed-owned
 * rows as "foreign" on every single boot. Arrays stay order-sensitive
 * (node order in a `dag.nodes` array is semantically meaningful).
 */
export function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) {
    return a === b;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => jsonDeepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj).sort();
    const bKeys = Object.keys(bObj).sort();
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i++) {
      if (aKeys[i] !== bKeys[i]) return false;
    }
    return aKeys.every((k) => jsonDeepEqual(aObj[k], bObj[k]));
  }
  return a === b;
}
