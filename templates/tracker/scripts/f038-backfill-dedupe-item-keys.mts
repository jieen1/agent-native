// SDLC-038 回溯去重迁移的真正落地实现 — 工单 cy9upfianv.
//
// 本脚本推翻了 server/lib/item-key-display.ts 顶部注释里"历史撞号永不改写,只加
// 不改"的旧决定:F8 的读路径消歧从撞号问题的主要应对方式降级为防御性兜底,本脚本
// 才是真正把历史撞号改写去重——对每个未挂 sprint(sprint_id 为空)的重复 itemKey,
// 保留最早创建的一行为权威(itemKey 不变),其余各行经 allocateItemKey() 分配一个
// 全新且唯一的 itemKey,并写入追加式审计(tracker_activities)与说明评论
// (tracker_comments)。绝不 UPDATE/DELETE 任何 comments/links/stages/artifacts 行。
//
// 独立运行时脚本(调用 process.exit),不是 vitest 套件——文件名刻意不含
// `.test`/`.spec` 以免被 vitest 收集,且位于 scripts/ 下,不在模板 tsconfig 的
// `include` 范围内(不参与应用 typecheck)。
//
// 用法:
//   tsx scripts/f038-backfill-dedupe-item-keys.mts --project <projectId> [--execute]
//
// 不传 --execute 时为 dry-run:只打印将要执行的重命名计划(staleId、oldItemKey、
// 将分配的新序号预览、authoritativeId),不写库。传 --execute 时真正执行
// applyDedupePlan 并打印每一步结果与最终摘要。脚本是幂等的:对已经去重完(不再有
// 重复 itemKey)的项目重新运行,plan 为空,不产生任何变更。
//
// 沿用现有 DATABASE_URL 环境变量约定(经 @agent-native/core/db 的 getDbExec),
// 不新增连接方式。

function log(...args: unknown[]) {
  console.log("[f038-backfill-dedupe]", ...args);
}

function parseArgs(argv: string[]): { projectId?: string; execute: boolean } {
  let projectId: string | undefined;
  let execute = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--project") {
      projectId = argv[++i];
    } else if (a.startsWith("--project=")) {
      projectId = a.slice("--project=".length);
    } else if (a === "--execute") {
      execute = true;
    }
  }
  return { projectId, execute };
}

async function main() {
  const { projectId, execute } = parseArgs(process.argv.slice(2));
  if (!projectId) {
    throw new Error(
      "usage: tsx scripts/f038-backfill-dedupe-item-keys.mts --project <projectId> [--execute]",
    );
  }

  const { getDbExec } = await import("@agent-native/core/db");
  const exec = getDbExec();

  // 项目的短 key(用于 allocateItemKey 拼新 itemKey,如 "SDLC")。
  const projRow = await exec.execute({
    sql: `SELECT key FROM tracker_projects WHERE id = ?`,
    args: [projectId],
  });
  const projectKey = String(
    (projRow.rows[0] as { key?: string } | undefined)?.key ?? "",
  );
  if (!projectKey) {
    throw new Error(`project not found for id: ${projectId}`);
  }
  log(`project=${projectId} key=${projectKey} mode=${execute ? "EXECUTE" : "DRY-RUN"}`);

  // 只取未挂 sprint 的历史工单(已挂 sprint 的不在本次范围内)。
  const rowsRes = await exec.execute({
    sql: `SELECT id, item_key, sprint_id, created_at FROM tracker_work_items
          WHERE project_id = ? AND (sprint_id IS NULL OR sprint_id = '')`,
    args: [projectId],
  });
  const rows = (rowsRes.rows as Array<{
    id: string;
    item_key: string | null;
    sprint_id: string | null;
    created_at: string;
  }>).map((r) => ({
    id: r.id,
    itemKey: r.item_key ?? "",
    sprintId: r.sprint_id ?? null,
    createdAt: r.created_at ?? "",
  }));
  log(`scanned ${rows.length} un-sprinted work item(s)`);

  const { computeDedupePlan, applyDedupePlan } = await import(
    "../server/lib/item-key-dedupe.js"
  );
  const plan = computeDedupePlan(rows);

  const collidingKeys = new Set(plan.map((p) => p.oldItemKey));
  if (plan.length === 0) {
    log("no duplicate itemKey among un-sprinted work items — nothing to do (idempotent).");
    process.exit(0);
  }
  log(
    `found ${collidingKeys.size} colliding itemKey(s) affecting ${plan.length} stale row(s): ${[...collidingKeys].join(", ")}`,
  );

  if (!execute) {
    // dry-run:预览将分配的新序号(从当前序列器的下一个号开始,不写库)。
    const { maxNumericSuffix } = await import(
      "../server/lib/item-key-sequencer.js"
    );
    const allKeys = await exec.execute({
      sql: `SELECT item_key FROM tracker_work_items WHERE project_id = ?`,
      args: [projectId],
    });
    let previewSeq = maxNumericSuffix(
      (allKeys.rows as Array<{ item_key?: string | null }>).map((r) => r.item_key),
    );
    log("DRY-RUN plan (no writes performed):");
    for (const p of plan) {
      previewSeq += 1;
      const previewKey = `${projectKey}-${String(previewSeq).padStart(3, "0")}`;
      log(
        `  stale=${p.staleId} oldItemKey=${p.oldItemKey} -> ~${previewKey} (authoritative=${p.authoritativeId})`,
      );
    }
    log("re-run with --execute to apply.");
    process.exit(0);
  }

  const results = await applyDedupePlan(exec, undefined, {
    projectId,
    projectKey,
    plan,
  });
  for (const r of results) {
    log(
      `  reassigned stale=${r.staleId} ${r.oldItemKey} -> ${r.newItemKey} (authoritative=${r.authoritativeId})`,
    );
  }
  log(
    `DONE: ${collidingKeys.size} colliding itemKey(s), ${results.length} row(s) reassigned.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[f038-backfill-dedupe] FATAL:", err);
  process.exit(1);
});
