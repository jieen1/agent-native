// SDLC-038 retroactive dedup migration (boot-time, idempotent, one-time).
//
// The itemKey race-condition fix (server/lib/item-key-sequencer.ts) stopped NEW
// duplicate itemKeys from being minted, but it never touched the rows that had
// ALREADY collided before the fix landed. The interim decision (see
// server/lib/item-key-display.ts's docblock and docs/sdlc-impl-f5-f10.md,
// 「历史重号不改(只加不改)」) left those duplicate itemKeys in place and only
// disambiguated them at READ time via computeItemKeyDisplay (suffixing
// '·' + id.slice(0,4)). That band-aid is insufficient because itemKey is also
// used as a RAW anchor elsewhere — dispatch tags, branch names, the
// brief:{itemKey} writeback key — none of which go through itemKeyDisplay.
//
// This module is the REAL fix for the historical data: a one-time pass that
// reassigns a brand-new itemKey to every "losing" duplicate row, fully
// preserving each row's id, comments, links, and stage history. None of
// tracker_comments / tracker_links / tracker_stages / tracker_artifacts /
// tracker_activities are keyed by item_key — they are all keyed by the work
// item's internal `id`, which never changes here — so a pure item_key rename
// cannot lose any of that history.
//
// SYSTEM-level maintenance: this runs at server boot with NO authenticated
// request context, so — exactly like the raw-SQL v27 migration backfill in
// server/plugins/db.ts that already scans the whole table — it intentionally
// does NOT apply ownerScope(); it must see every tenant's rows to find every
// collision. For each collision group (same projectId + itemKey, >1 row) the
// earliest-created row (createdAt asc, then id asc) is canonical and keeps its
// itemKey; every other row is a loser reassigned via the SAME atomic allocator
// (allocateItemKey) create-work-item uses, so the freshly-minted key can never
// collide with a future create-work-item call.
//
// Fail-open: the whole pass is wrapped in try/catch and swallows errors
// (console.error only) — mirrors the fail-open style in
// server/lib/scheduler-gate.ts and server/plugins/db.ts's verifyMigrationHashes.
// This runs at boot and must NEVER crash the server.
import { eq, inArray, ne } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { getDb, schema } from "../db/index.js";
import { allocateItemKey } from "./item-key-sequencer.js";

type Db = ReturnType<typeof getDb>;

// Same nanoid alphabet/length as actions/add-comment.ts.
const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

export interface DedupeItemKeyReportEntry {
  workItemId: string;
  projectId: string;
  oldKey: string;
  newKey: string;
}

/**
 * Reassign itemKeys for historically-duplicated work items.
 *
 * Idempotent: once every (projectId, itemKey) pair is unique there are zero
 * groups with >1 row, so a re-run finds nothing and returns an empty report
 * (no writes). Returns one entry per row actually renamed so callers/tests can
 * assert on the outcome.
 */
export async function dedupeItemKeys(
  db: Db,
): Promise<DedupeItemKeyReportEntry[]> {
  const report: DedupeItemKeyReportEntry[] = [];
  try {
    // Read every work item that has a non-empty itemKey, across ALL tenants
    // (no ownerScope — system-level boot pass, see module docblock).
    const rows = await db
      .select({
        id: schema.workItems.id,
        projectId: schema.workItems.projectId,
        itemKey: schema.workItems.itemKey,
        createdAt: schema.workItems.createdAt,
        ownerEmail: schema.workItems.ownerEmail,
        orgId: schema.workItems.orgId,
      })
      .from(schema.workItems)
      .where(ne(schema.workItems.itemKey, ""));
    type Row = (typeof rows)[number];

    // Group by (projectId, itemKey). A NUL separator keeps a projectId/itemKey
    // boundary unambiguous (neither field can contain NUL).
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const key = `${row.projectId}\u0000${row.itemKey}`;
      const arr = groups.get(key);
      if (arr) arr.push(row);
      else groups.set(key, [row]);
    }

    // Keep only true collisions (>1 row), sorting each so the FIRST row is the
    // canonical one (earliest createdAt, then lowest id as a stable tiebreak).
    // ISO-8601 createdAt strings sort chronologically as plain strings.
    const collisionGroups: Row[][] = [];
    const projectIds = new Set<string>();
    for (const group of groups.values()) {
      if (group.length <= 1) continue;
      group.sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
        if (a.id !== b.id) return a.id < b.id ? -1 : 1;
        return 0;
      });
      collisionGroups.push(group);
      // Only the losers (index >= 1) need a project-key lookup.
      for (let i = 1; i < group.length; i++) projectIds.add(group[i]!.projectId);
    }

    if (collisionGroups.length === 0) return report; // Nothing to do — idempotent no-op.

    // Batch-fetch every needed project's `key` prefix up front (no N+1 on the
    // hot path).
    const projectRows = await db
      .select({ id: schema.projects.id, key: schema.projects.key })
      .from(schema.projects)
      .where(inArray(schema.projects.id, Array.from(projectIds)));
    const projectKeys = new Map(projectRows.map((p) => [p.id, p.key]));

    for (const group of collisionGroups) {
      // group[0] is canonical and keeps its itemKey untouched.
      for (let i = 1; i < group.length; i++) {
        const loser = group[i]!;
        const projectKey = projectKeys.get(loser.projectId);
        if (!projectKey) {
          // Orphaned work item (project row gone) — cannot mint a prefixed key.
          // Skip defensively rather than crash the boot pass.
          console.error(
            `[dedupe-item-keys] no project key resolvable for project ${loser.projectId}; skipping work item ${loser.id}`,
          );
          continue;
        }

        const oldKey = loser.itemKey;
        // Reuse the existing atomic allocator verbatim so the new key can never
        // collide with a future create-work-item call for this project.
        const newKey = await allocateItemKey(loser.projectId, projectKey);
        const now = new Date().toISOString();

        await db
          .update(schema.workItems)
          .set({ itemKey: newKey, updatedAt: now })
          .where(eq(schema.workItems.id, loser.id));

        // Audit trail on the loser's work item (keyed by id, not item_key, so
        // this history survives the rename). ownerEmail/orgId come from the
        // work item's own row — there is no request context at boot.
        const body = `itemKey 迁移：因与项目内另一工单历史撞号，itemKey 由 ${oldKey} 重新分配为 ${newKey}（工单内容、评论、链接、阶段历史均原样保留；${oldKey} 现为该工单的历史遗留编号，不再唯一标识本工单）。`;
        await db.insert(schema.comments).values({
          id: nanoid(),
          workItemId: loser.id,
          authorKind: "system",
          authorName: "item-key-dedupe",
          body,
          createdAt: now,
          ownerEmail: loser.ownerEmail,
          orgId: loser.orgId ?? null,
          visibility: "private",
        });

        await db.insert(schema.activities).values({
          id: nanoid(),
          workItemId: loser.id,
          actorKind: "system",
          actorName: "item-key-dedupe",
          eventType: "itemKey迁移",
          payload: JSON.stringify({ oldKey, newKey }),
          createdAt: now,
          ownerEmail: loser.ownerEmail,
          orgId: loser.orgId ?? null,
          visibility: "private",
        });

        report.push({
          workItemId: loser.id,
          projectId: loser.projectId,
          oldKey,
          newKey,
        });
      }
    }
  } catch (err) {
    // Fail-open: a dedupe failure must never block server boot.
    console.error("[dedupe-item-keys] dedupe pass failed (swallowed):", err);
  }
  return report;
}
