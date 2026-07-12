import { defineAction } from "@agent-native/core";
import { z } from "zod";

import {
  auditColumns,
  auditMigrations,
  resolveRuntimeMigrationsSource,
  resolveRuntimeSchemaSource,
  stripDiffMarkers,
} from "../server/lib/migration-audit.js";

export interface AuditMigrationsChecklistItem {
  key: string;
  label: string;
  state: "pass" | "fail" | "needs-human";
}

export interface AuditMigrationsResult {
  missing: string[];
  missingColumns: string[];
  checklist: AuditMigrationsChecklistItem[];
}

/**
 * Shared implementation reused by this action's `run` and by
 * `server/lib/review-checklist.ts`'s diff-mode computation (both need the
 * exact same table+column reconciliation — kept in one place). Exported so
 * other server-side code can call it without going through the HTTP/agent
 * action surface.
 *
 * No-diff mode audits the CURRENTLY RUNNING instance's own schema/migrations
 * via runtime introspection (see `server/lib/migration-audit.ts`'s
 * module docblock for why not a build snapshot or fs.readFile). Diff mode
 * audits the diff's own added lines — the code under review is an unmerged
 * branch this running instance does not reflect.
 */
export async function runMigrationAudit(diff?: string): Promise<AuditMigrationsResult> {
  if (diff) {
    const added = stripDiffMarkers(diff);
    const tableAudit = auditMigrations(added, added);
    const columnAudit = auditColumns(diff, added);
    const missing = tableAudit.missing;
    const missingColumns = columnAudit.missing;
    const pass = missing.length === 0 && missingColumns.length === 0;
    return {
      missing,
      missingColumns,
      checklist: [
        {
          key: "migration-audit",
          label: "新表/新列 ↔ 迁移对账",
          state: pass ? "pass" : "fail",
        },
      ],
    };
  }

  const schemaSource = await resolveRuntimeSchemaSource();
  const migrationsSource = await resolveRuntimeMigrationsSource();
  const tableAudit = auditMigrations(schemaSource, migrationsSource);
  return {
    missing: tableAudit.missing,
    missingColumns: [],
    checklist: [
      {
        key: "migration-audit",
        label: "新表/新列 ↔ 迁移对账",
        state: tableAudit.missing.length === 0 ? "pass" : "fail",
      },
    ],
  };
}

export default defineAction({
  description:
    "F6 迁移对账 —— 不带 diff 时对当前运行实例自身的 schema.ts 声明表 vs " +
    "db.ts 迁移数组做全量对账(健康检查,读法见 server/lib/migration-audit.ts " +
    "module docblock:进程内省合成,零文件读取、零新增构建步骤);带 diff 时只在 " +
    "该 diff 新增的行内对账(评审卡机器预填用 —— 被审代码是未合并分支,当前 " +
    "运行实例不反映它)。",
  schema: z.object({
    diff: z
      .string()
      .optional()
      .describe(
        "Unified diff text for incremental (review-time) audit. Omit for a full audit of the running instance's own schema/migrations.",
      ),
  }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => runMigrationAudit(args.diff),
});
