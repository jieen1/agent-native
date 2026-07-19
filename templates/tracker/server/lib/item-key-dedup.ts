// SDLC-027 跨 sprint 撞号去重迁移 — the backtrack half of SDLC-038 that F8
// deliberately deferred. F8's sequencer (item-key-sequencer.ts) stopped NEW
// duplicate itemKeys from being minted, but the historical duplicates it left
// in place (SDLC-027/032/033/034/035/036/056/057 — 8 colliding itemKeys, 16
// rows, all sprint-less historical work items) are rewritten HERE, at boot.
//
// Why TypeScript (this file) and NOT a raw SQL migration: core's
// splitSqlStatements() (packages/core/src/db/migrations.ts) does not parse
// $$-quoted Postgres function bodies, so any DO $$ ... $$ block doing this
// per-row reallocation would be mis-split on its internal semicolons. A
// boot-time TS pass — the exact pattern verifyMigrationHashes() in
// server/plugins/db.ts already uses — sidesteps that entirely.
//
// Why NO ownerScope() here (don't "fix" this by adding it): this is a
// boot-time background maintenance pass over ALL data, analogous to a
// migration — there is NO request context at boot, so ownerScope()/
// getRequestUserEmail() would throw. Per-request reads (item-key-display.ts)
// still scope; this one must not.
//
// Safe to change item_key at all: every table hanging off a work item
// (comments/links/stages/artifacts/activities/rollback_log/exec_queue)
// foreign-keys on the work item's internal nanoid `id`, never on item_key —
// so reassigning an item_key orphans nothing. We only touch
// tracker_work_items.item_key plus the audit rows we add.
import { and, asc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { customAlphabet } from "nanoid";

import { getDb, schema } from "../db/index.js";
import { allocateItemKey } from "./item-key-sequencer.js";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

export interface DedupeResult {
  groupsFixed: number;
  rowsReassigned: number;
}

/**
 * Idempotently resolve every (project_id, item_key) pair that has >1 non-blank
 * row in tracker_work_items. The earliest-created row of each group keeps its
 * item_key (authoritative); every other row is reassigned a freshly-allocated
 * key via allocateItemKey(), with one activity + one comment audit row each.
 *
 * Re-derives the duplicate groups fresh on every call, so after the first
 * successful pass no groups remain and a second call is a cheap no-op (no
 * separate "already migrated" flag table needed). Never throws out — a
 * boot-time data-fix bug must not crash the tracker's boot.
 */
export async function dedupeLegacyItemKeys(): Promise<DedupeResult> {
  const result: DedupeResult = { groupsFixed: 0, rowsReassigned: 0 };
  try {
    const db = getDb();

    const dupGroups = await db
      .select({
        projectId: schema.workItems.projectId,
        itemKey: schema.workItems.itemKey,
        count: sql<number>`count(*)`,
      })
      .from(schema.workItems)
      .where(
        and(
          isNotNull(schema.workItems.itemKey),
          ne(schema.workItems.itemKey, ""),
        ),
      )
      .groupBy(schema.workItems.projectId, schema.workItems.itemKey)
      .having(sql`count(*) > 1`);

    for (const group of dupGroups) {
      try {
        const rows = await db
          .select({
            id: schema.workItems.id,
            projectId: schema.workItems.projectId,
            itemKey: schema.workItems.itemKey,
            createdAt: schema.workItems.createdAt,
            ownerEmail: schema.workItems.ownerEmail,
            orgId: schema.workItems.orgId,
            visibility: schema.workItems.visibility,
          })
          .from(schema.workItems)
          .where(
            and(
              eq(schema.workItems.projectId, group.projectId),
              eq(schema.workItems.itemKey, group.itemKey),
            ),
          )
          .orderBy(asc(schema.workItems.createdAt), asc(schema.workItems.id));

        if (rows.length < 2) continue;

        // Look up the project's `key` once per group (allocateItemKey needs it
        // to mint "KEY-NNN"). If the project row is gone, skip the group.
        const [project] = await db
          .select({ key: schema.projects.key })
          .from(schema.projects)
          .where(eq(schema.projects.id, group.projectId));
        if (!project) {
          console.error(
            `[item-key-dedup] project ${group.projectId} not found for duplicate itemKey ${group.itemKey}; skipping group`,
          );
          continue;
        }

        const [authoritative, ...rest] = rows;
        for (const row of rest) {
          const oldItemKey = row.itemKey;
          const newItemKey = await allocateItemKey(row.projectId, project.key);
          const now = new Date().toISOString();

          await db
            .update(schema.workItems)
            .set({ itemKey: newItemKey, updatedAt: now })
            .where(eq(schema.workItems.id, row.id));

          await db.insert(schema.activities).values({
            id: nanoid(),
            workItemId: row.id,
            actorKind: "agent",
            actorName: "itemKey去重迁移",
            eventType: "item_key.reassigned",
            payload: JSON.stringify({
              oldItemKey,
              newItemKey,
              authoritativeWorkItemId: authoritative!.id,
              authoritativeItemKey: authoritative!.itemKey,
              reason: "SDLC-027 跨sprint撞号去重迁移",
            }),
            createdAt: now,
            ownerEmail: row.ownerEmail,
            orgId: row.orgId,
            visibility: row.visibility,
          });

          await db.insert(schema.comments).values({
            id: nanoid(),
            workItemId: row.id,
            authorKind: "agent",
            authorName: "系统迁移(SDLC-027)",
            body: `本工单的 itemKey 因跨 sprint 撞号从 ${oldItemKey} 重新分配为 ${newItemKey};权威工单为 ${authoritative!.itemKey}(id=${authoritative!.id});评论/链接/阶段历史均未变更。`,
            createdAt: now,
            ownerEmail: row.ownerEmail,
            orgId: row.orgId,
            visibility: row.visibility,
          });

          result.rowsReassigned += 1;
        }
        result.groupsFixed += 1;
      } catch (err) {
        // One bad group must not abort the rest.
        console.error(
          `[item-key-dedup] failed to fix group projectId=${group.projectId} itemKey=${group.itemKey}:`,
          err,
        );
      }
    }

    if (result.groupsFixed > 0 || result.rowsReassigned > 0) {
      console.log(
        `[item-key-dedup] reassigned ${result.rowsReassigned} row(s) across ${result.groupsFixed} duplicate group(s)`,
      );
    }
  } catch (err) {
    console.error("[item-key-dedup] top-level failure (boot continues):", err);
  }
  return result;
}
// STABILITY_MARKER_1784480305
