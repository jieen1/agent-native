/**
 * F6 迁移对账 — 纯函数核心 + 运行时输入适配器。
 *
 * 设计权威:docs/sdlc-impl-f5-f10.md §2A(`server/lib/migration-audit.ts`)。
 *
 * ── 模块边界 ─────────────────────────────────────────────────────────────
 * 下半部分(`auditMigrations`/`auditColumns` 及其提取辅助函数)是纯函数:不碰
 * 数据库、不做网络 I/O,只接受字符串/数组,可直接用字面量文本单测(T-F6-01)。
 *
 * 上半部分(`resolveRuntimeSchemaSource`/`resolveRuntimeMigrationsSource`)是
 * 运行时适配器 —— 仍然零文件系统读、零网络 I/O,只做进程内省(见下)。
 *
 * ── R3 未定案项的澄清结论(迁移快照 vs 运行时读源码,实施前必须先定案) ──────
 * docs/sdlc-impl-f5-f10.md §2A 原文列出两个选项并各自的缺陷:
 *   (a) 构建期把 schema.ts/db.ts 的文本快照进 `server/generated/
 *       migration-snapshot.ts` —— tracker `package.json` 现无任何 prebuild/
 *       codegen 步骤,这条路无先例,需要新增构建管线。
 *   (b) 运行时 `fs.readFile` 源码文本 —— 101 dogfood 的 `an-tracker` 容器实测
 *       只有 `.output` 目录树下的 `.mjs` 编译产物、没有裸 `schema.ts` 源文件,
 *       这条路在生产部署下会直接读不到文件。
 * 本实现选择**第三条路,两者都不是**:不读任何文件、不新增任何构建步骤 ——
 *   - schema 表名不经"读 schema.ts 源码文本 + 正则"取得,而是从已经作为普通
 *     ES 模块 `import` 进内存的 Drizzle schema 对象,经 `getTableName()`
 *     内省取得(`db-migration.test.ts` 的 T-F3-12 早就是这样做的,此处只是把
 *     它做成一个可复用的适配器函数)。这在 `.ts` 源码树和 Nitro `.output`
 *     编译产物下完全等价 —— Drizzle table 对象是运行时一直存在的 JS 对象,
 *     从不依赖磁盘上是否还留着 `.ts` 源文件。
 *   - 迁移 SQL 文本不经"读 db.ts 源码文本 + 正则"取得,而是从 db.ts 具名导出
 *     的 `TRACKER_MIGRATIONS` 数组(见 `server/plugins/db.ts`)直接拼接其
 *     `.sql` 字段取得 —— 这也是普通 JS 数据,字符串字面量不会被任何打包器
 *     丢弃或改写,`.ts` 源码树和编译产物下同样等价。
 * 净效果:`auditMigrations`/`auditColumns` 的纯函数签名仍然是"文本进、结构
 * 出"(与文档原意一致,可直接单测字面量片段);唯一变化的是**运行时由谁提供
 * 这段文本** —— 由进程内省合成,而不是构建快照或磁盘读取。零新增构建步骤,
 * 两种部署形态(tracker 裸源码树 / orchestrator 编译产物)下行为一致。
 *
 * 增量对账(评审卡机器预填,`diff` 参数非空时)不经过这条内省路径 —— 被审的
 * 是一个尚未合并的开发分支,当前运行中的 tracker 实例是 `main`,并不反映该
 * 分支的改动。此时改为直接在 diff 文本本身内查找新增的 `+` 行(schema.ts 里
 * 新增的 `table("xxx")` 声明 / db.ts 里新增的 `CREATE TABLE IF NOT EXISTS xxx`
 * / `ADD COLUMN IF NOT EXISTS xxx`),两者原本就同属一次提交的 diff —— 见
 * `stripDiffMarkers`。
 */

import { getTableName } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Pure extraction + comparison
// ---------------------------------------------------------------------------

/** Matches tracker's schema helper: `table("tracker_xxx", { ... })`. */
const TABLE_DECL_RE = /\btable\(\s*["']([a-zA-Z_][a-zA-Z0-9_]*)["']/g;

/** Matches `CREATE TABLE IF NOT EXISTS xxx` (case-insensitive, as emitted by
 *  tracker's migration SQL strings). */
const CREATE_TABLE_RE = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;

/** Matches `ALTER TABLE ... ADD COLUMN IF NOT EXISTS col_name`. */
const ADD_COLUMN_RE =
  /ALTER\s+TABLE\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;

/** Matches a newly-added Drizzle column definition line, e.g.
 *  `  scaleEstimate: text("scale_estimate").default(null),` */
const DIFF_ADDED_COLUMN_RE =
  /:\s*(?:text|integer|real|boolean)\(\s*["']([a-zA-Z_][a-zA-Z0-9_]*)["']/;

/** Matches a WHOLE new-table declaration's immediate field object —
 *  `table("name", { ...fields... }` — non-greedy up to the first `}` (this
 *  codebase's Drizzle column defs never nest object literals, so the first
 *  `}` reliably closes the fields block). Used to EXCLUDE a brand-new table's
 *  own fields from column-diff auditing: a field on a table that doesn't
 *  exist yet is covered by the table-level CREATE TABLE audit, not an ALTER
 *  COLUMN — without this exclusion, e.g. `id: text("id").primaryKey()` inside
 *  a newly-added table reads exactly like a Drizzle column declaration and
 *  gets misflagged as a "missing ADD COLUMN" (see T-F6-02's SDLC-061 replay
 *  fixture, which is a whole new table with no ALTER statements at all —
 *  caught empirically running the real test, not a hypothetical). */
const NEW_TABLE_FIELD_BLOCK_RE =
  /\btable\(\s*["'][a-zA-Z_][a-zA-Z0-9_]*["']\s*,\s*\{[\s\S]*?\}/g;

function uniqueMatches(re: RegExp, source: string, group = 1): string[] {
  const names = new Set<string>();
  const fresh = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = fresh.exec(source))) {
    const value = m[group];
    if (value) names.add(value);
  }
  return [...names];
}

/** Extract every table name declared via `table("xxx", ...)` in a schema
 *  source blob (real schema.ts text, or a synthesized equivalent — see
 *  `resolveRuntimeSchemaSource`). */
export function extractSchemaTableNames(schemaSource: string): string[] {
  return uniqueMatches(TABLE_DECL_RE, schemaSource, 1);
}

/** Extract every table name created via `CREATE TABLE IF NOT EXISTS xxx` in a
 *  migrations source blob (concatenated migration SQL text). */
export function extractMigrationCreatedTables(migrationsSource: string): string[] {
  return uniqueMatches(CREATE_TABLE_RE, migrationsSource, 1);
}

/** Extract every `table.column` pair added via `ALTER TABLE t ADD COLUMN IF
 *  NOT EXISTS c` in a migrations source blob. Returned as lowercase `t.c`
 *  strings for case-insensitive comparison. */
export function extractMigrationAddedColumns(migrationsSource: string): string[] {
  const pairs = new Set<string>();
  const re = new RegExp(ADD_COLUMN_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(migrationsSource))) {
    pairs.add(`${m[1]!.toLowerCase()}.${m[2]!.toLowerCase()}`);
  }
  return [...pairs];
}

/** Extract column SQL names newly declared in a schema.ts diff hunk. This is
 *  intentionally NOT table-scoped (see module docblock's "增量对账" note) —
 *  it flags any `+`-added Drizzle column definition line found anywhere in
 *  the diff text passed in. Callers that already scoped the text to
 *  added-lines-only (via `stripDiffMarkers`) get a clean signal; callers that
 *  pass a raw unified diff should call `stripDiffMarkers` first. */
export function extractDiffAddedColumns(diffAddedText: string): string[] {
  // Strip whole new-table field blocks first — see NEW_TABLE_FIELD_BLOCK_RE's
  // docblock for why a new table's own fields aren't "added columns".
  const withoutNewTableBlocks = diffAddedText.replace(NEW_TABLE_FIELD_BLOCK_RE, "");
  const names = new Set<string>();
  for (const line of withoutNewTableBlocks.split("\n")) {
    const m = DIFF_ADDED_COLUMN_RE.exec(line);
    if (m?.[1]) names.add(m[1]);
  }
  return [...names];
}

/** Keep only the ADDED-line content of a unified diff (drop the leading `+`,
 *  never include `+++` file-header lines or unchanged/removed lines). Used to
 *  scope extraction to what a proposed change actually introduces, ignoring
 *  unrelated context lines a diff hunk carries around the change. */
export function stripDiffMarkers(diffText: string): string {
  return diffText
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

export interface MigrationAuditTable {
  name: string;
  hasCreate: boolean;
}

export interface MigrationAuditResult {
  tables: MigrationAuditTable[];
  missing: string[];
}

/**
 * Reconcile schema-declared tables against migration-created tables.
 *
 * Only checks the schema→migrations direction (every schema table must have
 * a corresponding `CREATE TABLE IF NOT EXISTS`) — a migrations source that
 * creates MORE tables than schema currently declares is allowed (e.g. retired
 * un-namespaced v1-v3 tables, or the bookkeeping table itself) and must never
 * be reported as missing.
 */
export function auditMigrations(
  schemaSource: string,
  migrationsSource: string,
): MigrationAuditResult {
  const schemaTables = extractSchemaTableNames(schemaSource);
  const created = new Set(extractMigrationCreatedTables(migrationsSource));
  const tables = schemaTables.map((name) => ({ name, hasCreate: created.has(name) }));
  const missing = tables.filter((t) => !t.hasCreate).map((t) => t.name);
  return { tables, missing };
}

export interface ColumnAuditResult {
  columns: string[];
  missing: string[];
}

/**
 * Reconcile newly-added schema columns (from a diff) against migration
 * `ADD COLUMN IF NOT EXISTS` statements. `diffText` is matched WITHOUT
 * stripping (so callers can pass a raw unified diff directly); the added-line
 * scoping happens internally via `stripDiffMarkers`.
 *
 * Column matching is intentionally NOT table-scoped — see module docblock.
 * This is a deliberate simplification: full table-scoped diff parsing would
 * require tracking which `table(...)` block a hunk's context lines belong to,
 * which unified diffs don't always carry (a column added deep inside a large
 * table's block may have zero table-open context in the same hunk). Column
 * names in this codebase are descriptive enough (`scale_estimate`,
 * `split_parent_id`, `hash`) that name-only matching is a safe, testable
 * heuristic for a machine-prefill advisory check, not a hard gate.
 */
export function auditColumns(diffText: string, migrationsSource: string): ColumnAuditResult {
  const added = extractDiffAddedColumns(stripDiffMarkers(diffText));
  const migratedPairs = extractMigrationAddedColumns(migrationsSource);
  const migratedColumnNames = new Set(migratedPairs.map((p) => p.split(".")[1]!));
  const missing = added.filter((c) => !migratedColumnNames.has(c.toLowerCase()));
  return { columns: added, missing };
}

// ---------------------------------------------------------------------------
// Runtime adapters — process introspection only, zero fs/network I/O.
// See module docblock for why this replaces both the "build snapshot" and
// the "runtime fs.readFile" options the design doc left undecided.
// ---------------------------------------------------------------------------

/**
 * Synthesize a schema-source-equivalent text blob from the already-imported
 * Drizzle schema module: `table("name")\n` per declared table. Feeding this
 * into `extractSchemaTableNames` yields exactly the real declared table-name
 * set, with no file read.
 */
export async function resolveRuntimeSchemaSource(): Promise<string> {
  const schemaModule = await import("../db/schema.js");
  const names: string[] = [];
  for (const value of Object.values(schemaModule)) {
    if (value && typeof value === "object") {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors
        // db-migration.test.ts's own `getTableName(t as any)` cast: iterating
        // arbitrary schema module exports can't statically narrow to `Table`.
        names.push(getTableName(value as any));
      } catch {
        // Not a Drizzle table export (e.g. a re-exported helper) — skip.
      }
    }
  }
  return names.map((n) => `table("${n}")`).join("\n");
}

/**
 * Concatenate every migration entry's SQL (both dialect branches, when
 * dialect-gated) from db.ts's named `TRACKER_MIGRATIONS` export into one text
 * blob, with no file read.
 */
export async function resolveRuntimeMigrationsSource(): Promise<string> {
  const dbPluginModule = (await import("../plugins/db.js")) as {
    TRACKER_MIGRATIONS: Array<{ sql: string | { postgres?: string; sqlite?: string } }>;
  };
  const migrations = dbPluginModule.TRACKER_MIGRATIONS ?? [];
  return migrations
    .map((m) =>
      typeof m.sql === "string" ? m.sql : [m.sql.postgres, m.sql.sqlite].filter(Boolean).join("\n"),
    )
    .join("\n");
}
