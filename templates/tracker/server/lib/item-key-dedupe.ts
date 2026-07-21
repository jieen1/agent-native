import type { getDbExec } from "@agent-native/core/db";
// SDLC-038 回溯去重迁移 (工单 cy9upfianv) — itemKey 跨 sprint 撞号的真正落地去重.
//
// 本模块推翻了 item-key-display.ts 顶部注释里"历史撞号永不改写,只加不改"的旧
// 决定:F8 上线的读路径消歧(撞号 itemKey 展示时追加 `·<id前4位>` 后缀)从"撞号
// 问题的唯一/主要应对方式"降级为防御性兜底;本模块才是真正把历史撞号改写去重——
// 对每个未挂 sprint 的重复 itemKey,保留最早创建的一行为"权威"(itemKey 不变),
// 其余各行经 allocateItemKey() 分配一个全新且唯一的 itemKey,并写入追加式审计
// (tracker_activities)与说明评论(tracker_comments)。
//
// 范围与约束:
//   - 只处理 sprintId 为空(NULL/'')的未挂 sprint 历史工单;已挂 sprint 的行不在
//     本次范围内,跳过。
//   - DB 变更是加性的:只 UPDATE 撞号行的 item_key,只向 activities/comments
//     INSERT 新行;绝不 UPDATE/DELETE 任何 tracker_comments / tracker_links /
//     tracker_stages / tracker_artifacts 行——这些表只以 work_item_id 关联,天然
//     不受 itemKey 改写影响。
//   - 只用简单的参数化 INSERT/UPDATE(`?` 占位),Postgres 与 SQLite/libsql 两种
//     方言都支持;不引入任何新的 dialect-specific SQL。新 itemKey 的分配复用
//     item-key-sequencer.ts 的 allocateItemKey()(其内部按 isPostgres() 分支)。
import { customAlphabet } from "nanoid";

import { allocateItemKey } from "./item-key-sequencer.js";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

export interface DedupeInputRow {
  id: string;
  itemKey: string;
  sprintId: string | null;
  createdAt: string;
}

export interface DedupePlanEntry {
  /** 需要被重新分配新 itemKey 的行(撞号组内非权威的重复行)。 */
  staleId: string;
  /** 该行当前的(撞号)itemKey。 */
  oldItemKey: string;
  /** 撞号组内最早创建、保留原 itemKey 的权威行 id。 */
  authoritativeId: string;
}

/**
 * 纯函数:从未挂 sprint 的历史工单行里计算出回溯去重计划。
 *
 * 按 itemKey 分组(只考虑 sprintId 为 null/空字符串的行;已挂 sprint 的行跳过),
 * 组内按 createdAt 升序排序,最早创建的一行视为"权威"(保留原 itemKey,不出现在
 * 返回结果里),其余每一行各生成一条 {staleId, oldItemKey, authoritativeId} 记录。
 * itemKey 为空/blank 的行不参与分组(各自独立,不当作"相同 key")。组大小为 1 的
 * itemKey 不产生任何记录。一个 itemKey 重复 N(>=2) 次会产生 N-1 条记录,且全部
 * 共享同一个 authoritativeId。
 */
export function computeDedupePlan(rows: DedupeInputRow[]): DedupePlanEntry[] {
  const groups = new Map<string, DedupeInputRow[]>();
  for (const r of rows) {
    const itemKey = String(r.itemKey ?? "");
    if (itemKey.trim() === "") continue; // blank/empty -> 各自独立,不分组
    const sprintId = r.sprintId == null ? "" : String(r.sprintId).trim();
    if (sprintId !== "") continue; // 已挂 sprint 的行不在本次范围内
    const arr = groups.get(itemKey);
    if (arr) arr.push(r);
    else groups.set(itemKey, [r]);
  }

  const plan: DedupePlanEntry[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue; // 组大小为 1 -> 无撞号,不产生记录
    const sorted = [...group].sort((a, b) =>
      String(a.createdAt).localeCompare(String(b.createdAt)),
    );
    const authoritative = sorted[0]!;
    for (let i = 1; i < sorted.length; i++) {
      const stale = sorted[i]!;
      plan.push({
        staleId: stale.id,
        oldItemKey: String(stale.itemKey ?? ""),
        authoritativeId: authoritative.id,
      });
    }
  }
  return plan;
}

export interface ApplyDedupePlanOptions {
  projectId: string;
  projectKey: string;
  plan: DedupePlanEntry[];
}

export interface ApplyDedupePlanResult {
  staleId: string;
  oldItemKey: string;
  newItemKey: string;
  authoritativeId: string;
}

/** 一个 work item 的所有权(owner_email / org_id)。 */
interface Ownership {
  ownerEmail: string;
  orgId: string | null;
}

/**
 * 读出某个 work item 自身的真实 owner_email / org_id。
 *
 * tracker_activities / tracker_comments 两张表都带 ownableColumns()(见
 * server/db/schema.ts;server/plugins/db.ts 的建表 SQL 是
 * `owner_email TEXT NOT NULL DEFAULT 'local@localhost'`、`org_id TEXT` 可空),
 * 而本仓库其余所有对这两张表的写入(actions/add-comment.ts、
 * actions/transition-work-item.ts、actions/create-artifact.ts、
 * server/lib/dispatch-gate.ts 等)都显式设置了 ownerEmail/orgId。去重迁移产出
 * 的审计/说明记录理应继承被迁移工单自己的所有权——否则新插入的行会悄悄落到 DB
 * 默认值 owner_email='local@localhost'、org_id=NULL,而 actions/list-comments.ts
 * 与 actions/list-tracker-activities.ts 读取时用 ownerScope()
 * (eq(ownerEmail, requestUser) OR eq(orgId, requestOrgId)) 做 WHERE 过滤,真实
 * 用户(有自己的 ownerEmail/orgId)将永远看不到这些行,彻底违背写这些记录的初衷。
 *
 * 防御性兜底:理论上 plan 里的 id 都来自真实存在的 work item 行;万一查不到,
 * 回退到与建表 SQL 一致的默认值(owner_email='local@localhost'、org_id=NULL),
 * 保证绝不向 NOT NULL 列插入 NULL。
 */
async function loadOwnership(
  exec: ReturnType<typeof getDbExec>,
  workItemId: string,
): Promise<Ownership> {
  const res = await exec.execute({
    sql: `SELECT owner_email, org_id FROM tracker_work_items WHERE id = ?`,
    args: [workItemId],
  });
  const row = res.rows[0] as
    | { owner_email?: string | null; org_id?: string | null }
    | undefined;
  return {
    ownerEmail: row?.owner_email ?? "local@localhost",
    orgId: row?.org_id ?? null,
  };
}

/**
 * 把 computeDedupePlan 的结果真正写入库。对 plan 里的每一条记录:
 *   a. UPDATE tracker_work_items 把撞号行的 item_key 改为全新且唯一的 key;
 *   b. 向 tracker_activities 追加一条 event_type='item-key.reassigned' 审计记录;
 *   c. 向 tracker_comments 追加一条 agent 身份说明评论(在被改名的 stale 行上);
 *   d. 向 tracker_comments 追加一条 agent 身份说明评论(在权威行上)。
 *
 * 绝不 UPDATE/DELETE 任何 comments/links/stages/artifacts 行。`db` 参数保留以
 * 对齐调用方既有签名习惯,但本函数只用 `exec` 的简单参数化 SQL(两种方言通用)。
 */
export async function applyDedupePlan(
  exec: ReturnType<typeof getDbExec>,
  db: unknown,
  { projectId, projectKey, plan }: ApplyDedupePlanOptions,
): Promise<ApplyDedupePlanResult[]> {
  void db;
  const results: ApplyDedupePlanResult[] = [];
  for (const entry of plan) {
    const newItemKey = await allocateItemKey(projectId, projectKey);
    const now = new Date().toISOString();

    // 读出 stale 行与权威行各自真实的 owner_email / org_id,新插入的
    // activities/comments 行原样继承被迁移工单自己的所有权(见 loadOwnership 注释)。
    const staleOwnership = await loadOwnership(exec, entry.staleId);
    const authOwnership = await loadOwnership(exec, entry.authoritativeId);

    // a. 改名撞号行
    await exec.execute({
      sql: `UPDATE tracker_work_items SET item_key = ?, updated_at = ? WHERE id = ?`,
      args: [newItemKey, now, entry.staleId],
    });

    // b. 追加式审计记录(不覆盖任何已有行)——显式带上 owner_email / org_id,
    //    继承 stale 工单自身的所有权,不依赖 DB 默认值。
    await exec.execute({
      sql: `INSERT INTO tracker_activities (id, work_item_id, actor_kind, actor_name, event_type, payload, created_at, owner_email, org_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        nanoid(),
        entry.staleId,
        "agent",
        "智能体",
        "item-key.reassigned",
        JSON.stringify({
          oldItemKey: entry.oldItemKey,
          newItemKey,
          authoritativeWorkItemId: entry.authoritativeId,
          reason: "SDLC-038 backfill dedupe (cy9upfianv)",
        }),
        now,
        staleOwnership.ownerEmail,
        staleOwnership.orgId,
      ],
    });

    // c. 在被改名(stale)工单上的 agent 说明评论——继承 stale 工单的所有权。
    await exec.execute({
      sql: `INSERT INTO tracker_comments (id, work_item_id, author_kind, author_name, body, created_at, owner_email, org_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        nanoid(),
        entry.staleId,
        "agent",
        "智能体",
        `本工单的 itemKey 因跨 sprint 撞号已从 ${entry.oldItemKey} 改为 ${newItemKey}。原因:SDLC-038 回溯去重迁移(cy9upfianv);权威工单为 ${entry.authoritativeId}(保留原 itemKey ${entry.oldItemKey})。`,
        now,
        staleOwnership.ownerEmail,
        staleOwnership.orgId,
      ],
    });

    // d. 在权威工单上的 agent 说明评论——继承权威工单自身的所有权。
    await exec.execute({
      sql: `INSERT INTO tracker_comments (id, work_item_id, author_kind, author_name, body, created_at, owner_email, org_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        nanoid(),
        entry.authoritativeId,
        "agent",
        "智能体",
        `本工单的 itemKey ${entry.oldItemKey} 被确认为权威保留。重号工单 ${entry.staleId} 已被改名为 ${newItemKey}(SDLC-038 回溯去重迁移,cy9upfianv)。`,
        now,
        authOwnership.ownerEmail,
        authOwnership.orgId,
      ],
    });

    results.push({
      staleId: entry.staleId,
      oldItemKey: entry.oldItemKey,
      newItemKey,
      authoritativeId: entry.authoritativeId,
    });
  }
  return results;
}
