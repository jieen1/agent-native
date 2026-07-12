// F8: itemKey 消歧(读路径). Historical duplicate itemKeys (SDLC-032~036 —
// pre-sequencer count(*) races minted the same itemKey twice within a
// project) are NEVER rewritten (only-add, no-change red line — 迁移只加不改
// applies to data too, not just schema). Instead every read path that shows
// an itemKey to a human appends a short id suffix when — and only when — a
// (projectId, itemKey) pair is not unique, so a human can tell two same-
// labeled items apart. Single-item contexts where no comparison is possible
// (e.g. run-acceptance.ts's report title for the one item being accepted)
// don't need this.
//
// Detection is against the FULL project population, not just the batch of
// rows a given read happens to fetch — e.g. list-work-items filtered to
// status=open must still flag a duplicate whose sibling is status=closed and
// therefore absent from that filtered batch.
import { and, inArray } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";
import { ownerScope } from "./access.js";

type Db = ReturnType<typeof getDb>;

export interface ItemKeyRow {
  id: string;
  projectId: string;
  itemKey: string | null | undefined;
}

/** Map from work-item id -> the itemKey to DISPLAY (raw itemKey, or itemKey
 *  + '·' + id.slice(0,4) when it collides with a sibling in the same
 *  project). Rows with a blank/null itemKey are returned as-is (never
 *  suffixed — nothing to disambiguate a blank against). */
export async function computeItemKeyDisplays(
  db: Db,
  rows: ItemKeyRow[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const projectIds = Array.from(
    new Set(rows.filter((r) => r.itemKey).map((r) => r.projectId)),
  );
  if (projectIds.length === 0) {
    for (const r of rows) out.set(r.id, r.itemKey ?? "");
    return out;
  }

  // ownerScope() so the duplicate-count query never scans a different
  // tenant's rows sharing the same (random, unguessable) projectId — a
  // required scope check for any query against an ownableColumns() table
  // (see security/storing-data skills), not just a correctness nicety here.
  const siblings = await db
    .select({
      projectId: schema.workItems.projectId,
      itemKey: schema.workItems.itemKey,
    })
    .from(schema.workItems)
    .where(and(ownerScope(schema.workItems), inArray(schema.workItems.projectId, projectIds)));

  const counts = new Map<string, number>();
  for (const s of siblings) {
    if (!s.itemKey) continue;
    const key = `${s.projectId} ${s.itemKey}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  for (const r of rows) {
    if (!r.itemKey) {
      out.set(r.id, r.itemKey ?? "");
      continue;
    }
    const key = `${r.projectId} ${r.itemKey}`;
    const isDuplicate = (counts.get(key) ?? 0) > 1;
    out.set(r.id, isDuplicate ? `${r.itemKey}·${r.id.slice(0, 4)}` : r.itemKey);
  }
  return out;
}

/** Convenience for the common single-item case (get-work-item): resolve one
 *  row's display key without the caller building a 1-element array. */
export async function computeItemKeyDisplay(
  db: Db,
  row: ItemKeyRow,
): Promise<string> {
  const map = await computeItemKeyDisplays(db, [row]);
  return map.get(row.id) ?? row.itemKey ?? "";
}
