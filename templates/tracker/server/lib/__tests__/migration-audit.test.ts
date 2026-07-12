import { describe, expect, it } from "vitest";

import {
  auditColumns,
  auditMigrations,
  extractDiffAddedColumns,
  extractMigrationAddedColumns,
  extractMigrationCreatedTables,
  extractSchemaTableNames,
  stripDiffMarkers,
} from "../migration-audit.js";

// ============================================================================
// T-F6-01: auditMigrations 纯函数 —— 对账确定性
//
// docs/sdlc-impl-f5-f10.md §2E T-F6-01: "test.each:①全对账 ②schema 多一表
// ③迁移多一表(允许) ④列级 diff 对账" → "missing 精确等于缺失集;③不误报"
// ============================================================================

describe("T-F6-01: auditMigrations 纯函数对账确定性", () => {
  const FULL_SCHEMA = `
export const projects = table("tracker_projects", { id: text("id").primaryKey() });
export const workItems = table("tracker_work_items", { id: text("id").primaryKey() });
`;

  const FULL_MIGRATIONS = `
CREATE TABLE IF NOT EXISTS tracker_projects (id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS tracker_work_items (id TEXT PRIMARY KEY);
`;

  it("① 全对账:schema 与迁移完全对齐 → missing 为空", () => {
    const result = auditMigrations(FULL_SCHEMA, FULL_MIGRATIONS);
    expect(result.tables).toEqual([
      { name: "tracker_projects", hasCreate: true },
      { name: "tracker_work_items", hasCreate: true },
    ]);
    expect(result.missing).toEqual([]);
  });

  it("② schema 多一表(缺迁移)→ missing 精确等于缺失集(重放 SDLC-061 精确名单)", () => {
    const schemaWithExtra = `${FULL_SCHEMA}
export const artifactReviews = table("tracker_artifact_reviews", { id: text("id").primaryKey() });
`;
    const result = auditMigrations(schemaWithExtra, FULL_MIGRATIONS);
    expect(result.missing).toEqual(["tracker_artifact_reviews"]);
    expect(result.tables.find((t) => t.name === "tracker_artifact_reviews")).toEqual({
      name: "tracker_artifact_reviews",
      hasCreate: false,
    });
  });

  it("③ 迁移多一表(允许,不误报)—— schema 未声明的表存在建表迁移,missing 仍为空", () => {
    const migrationsWithExtra = `${FULL_MIGRATIONS}
CREATE TABLE IF NOT EXISTS tracker_migrations (version INTEGER PRIMARY KEY);
`;
    const result = auditMigrations(FULL_SCHEMA, migrationsWithExtra);
    expect(result.missing).toEqual([]);
    // The bookkeeping table is not reported at all (audit only walks schema→migrations).
    expect(result.tables.some((t) => t.name === "tracker_migrations")).toBe(false);
  });

  it("④ 列级 diff 对账:新增列有对应 ADD COLUMN → missing 为空;缺失 → missing 命中该列", () => {
    const diffWithMigration = `
diff --git a/templates/tracker/server/db/schema.ts b/templates/tracker/server/db/schema.ts
+  scaleEstimate: text("scale_estimate").default(null),
diff --git a/templates/tracker/server/plugins/db.ts b/templates/tracker/server/plugins/db.ts
+      sql: \`ALTER TABLE tracker_work_items ADD COLUMN IF NOT EXISTS scale_estimate TEXT\`,
`;
    const migrated = extractMigrationAddedColumns(
      `ALTER TABLE tracker_work_items ADD COLUMN IF NOT EXISTS scale_estimate TEXT`,
    );
    expect(migrated).toEqual(["tracker_work_items.scale_estimate"]);

    const passResult = auditColumns(
      diffWithMigration,
      `ALTER TABLE tracker_work_items ADD COLUMN IF NOT EXISTS scale_estimate TEXT`,
    );
    expect(passResult.columns).toEqual(["scale_estimate"]);
    expect(passResult.missing).toEqual([]);

    const failResult = auditColumns(diffWithMigration, ""); // no migration SQL at all
    expect(failResult.missing).toEqual(["scale_estimate"]);
  });

  it("extractSchemaTableNames / extractMigrationCreatedTables are order-preserving-unique", () => {
    expect(extractSchemaTableNames(FULL_SCHEMA)).toEqual([
      "tracker_projects",
      "tracker_work_items",
    ]);
    expect(extractMigrationCreatedTables(FULL_MIGRATIONS)).toEqual([
      "tracker_projects",
      "tracker_work_items",
    ]);
  });

  it("stripDiffMarkers keeps only '+'-added lines, dropping '+++' file headers and context/removed lines", () => {
    const diff = `diff --git a/x b/x
+++ b/x
--- a/x
 context line unchanged
-removed line
+added line one
+added line two
`;
    expect(stripDiffMarkers(diff)).toBe("added line one\nadded line two");
  });

  it("extractDiffAddedColumns only matches Drizzle-shaped column declarations", () => {
    const added = stripDiffMarkers(`
+  splitParentId: text("split_parent_id").default(null),
+  // just a comment, not a column
+  risk: text("risk").notNull().default("medium"),
`);
    expect(extractDiffAddedColumns(added).sort()).toEqual(["risk", "split_parent_id"]);
  });
});
