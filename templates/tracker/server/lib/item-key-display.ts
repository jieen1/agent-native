// F8: itemKey 消歧(读路径) — 现为防御性兜底. 历史撞号(pre-sequencer count(*)
// races 在同一项目内把同一 itemKey 发了两次)现在已由 scripts/f038-backfill-
// dedupe-item-keys.mts --execute 真正回溯改写去重(SDLC-038, 工单 cy9upfianv):
// 对每个未挂 sprint 的重复 itemKey,保留最早创建的一行为权威,其余各行被分配全新
// 且唯一的 itemKey。这推翻了本文件旧版注释里"历史撞号永不改写,只加不改"的决定。
//
// 因此本读路径消歧函数(computeItemKeyDisplays / computeItemKeyDisplay)不再是
// 撞号问题的唯一/主要应对方式,而是防御性兜底:万一未来又通过其它写法引入撞号,
// 或某个项目还没跑过 f038 backfill,展示层仍能在 (projectId, itemKey) 不唯一时
// 追加 `·<id前4位>` 后缀,让人能区分两个同标签的工单。不需要比较的单工单上下文
// (如 run-acceptance.ts 对单个被验收工单的报表标题)无需消歧。
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
