/**
 * F6 评审核对清单 — 按工作项 nature 装配的硬核对项 + 持久化/完成度解析。
 *
 * 设计权威:docs/sdlc-impl-f5-f10.md §2A(`server/lib/review-checklist.ts`)/
 * §2B(前端呈现)+ docs/sdlc-product-design/03-tracker.md §2(评审卡核对清单)。
 *
 * ── 模块边界(mirrors `server/lib/dispatch-gate.ts`'s own split) ──────────
 * `assembleChecklist` 是纯函数:给定 nature 数组 + 已算好的 diff 元数据,
 * 装配出这张工作项应有的核对项数组,不碰数据库。
 *
 * 其余函数会 touch DB,采用与 `dispatch-gate.ts` 相同的依赖注入约定 ——
 * `db: ReturnType<typeof getDb>` 作首参 —— 这样 `actions/
 * get-review-checklist.ts`(渲染)和 `actions/transition-work-item.ts`
 * (done 守卫)共享一套解析逻辑,不需要 action 之间互相 import。
 *
 * ── 两条严格分离的路径(R3 独立评审 F-1 修复:守卫死锁根治) ────────────────
 * 渲染路径(`computeChecklistState`,`get-review-checklist` 调用,带 diff):
 *   *写*路径 —— 惰性建锚点、把机器项判定按 diff 结果写回持久化、给人工项建
 *   占位行(checked=0)。这是核对清单唯一的写入点(“渲染时写”)。
 * 守卫路径(`isChecklistComplete`,`transition-work-item` done 分支调用,无 diff):
 *   *纯只读* —— 绝不重算机器项、绝不写任何行。只读评审时已持久化的机器判定 +
 *   人工确认,据此判 complete(“守卫只读信任”)。
 *
 * 为什么必须分离(F-1 实证的阻断级死锁):守卫若走渲染路径(无 diff),会用
 * 无-diff 语境重算机器项 —— 例如 nature 含「数据」时装配出 `迁移冒烟证据在场`
 * 机器项,无 diff 下判 needs-human → 回写 checked=0,把评审时(有 diff)已判
 * pass、已写 checked=1 的行覆盖回 0;而机器项 UI 不可人工勾 → done 永远被拒
 * (fail-closed 死锁)。故守卫严格只读。
 *
 * ── 锚点(R3 评审 F-2/F-3 修复:门要对所有交付项有牙,不再空转) ────────────
 * 锚点给核对项一个稳定的 (artifactId, version) 持久化坐标(复用 B5 的
 * `tracker_artifact_reviews`,reviewKey 命名空间 `checklist:<key>`),并承载
 * “产物出新版本 → 勾选重置” 语义。两类:
 *   - sprint 内项(有 sprintId):锚定 `tracker_sprint_artifacts` 的
 *     `docKey=review:<workItemId>` 最新版本。渲染时若不存在则**惰性建一行**
 *     (F-2:此前无任何 action 建此锚点 → resolveChecklistAnchor 恒返回 null →
 *     `!anchor → complete:true` 门恒空转 → SDLC-061 在运行系统里没关)。惰性
 *     建行直接 INSERT 一行 sprint 产物(不走 `create-sprint-artifact` action:
 *     该 action 带 B2 stale-approval 逻辑,对一个纯评审锚点不需要、也不该触发;
 *     语义上仍是同形状的 sprint 产物行,满足 F-2 “用 create-sprint-artifact
 *     惰性建”的意图)。真正的“重置”版本递增仍由 `create-sprint-artifact`
 *     action 在交付重做时产生(T-F6-07 覆盖)。
 *   - sprint 外项(quick-task/hotfix/from-audit,无 sprintId,F-3):
 *     `tracker_sprint_artifacts.sprint_id` 是 NOT NULL,无法建 sprint 产物行。
 *     **决策(F-3,倾向“门对所有交付项有牙”):**给它一个**合成锚点**
 *     `{artifactId: "wi-review:<workItemId>", version: 1, kind: "synthetic"}`
 *     —— 不建任何产物行(`tracker_artifact_reviews.artifactId` 是自由字符串,
 *     持久化/读取/`set-artifact-review` 都只把它当不透明键)。代价:sprint 外
 *     项不走 sprint 产物的版本化生命周期,故 version 恒 1、无“出新版本自动
 *     重置”(它们本就不产生版本化 sprint 产物;重做后重新评审由人工触发)。
 *     这是有意限制,换取门对 sprint 外交付项同样有牙。
 *
 * ── 守卫“评审是否已发生”的判定(避免 S5 UI 落地前把 done 锁死) ────────────
 *   - sprint 内项:没有 sprint 产物锚点 = 评审从未渲染 → 守卫 `!anchor` 放行
 *     (complete:true)。一旦渲染(get-review-checklist 惰性建锚 + 写全套占位
 *     行),锚点出现 → 守卫要求全部确认。生产中“有锚点 ⟺ 有行”(同一次
 *     渲染原子完成);“有锚点但零行”只在测试手工插锚点时出现 → 守卫 fail-closed
 *     拒绝(T-F6-06 用例①的语义)。
 *   - sprint 外项:合成锚点恒可解析(无行可作存在信号),故以“持久化行数>0”
 *     作为“评审已渲染”的信号:零行 → 视为未渲染 → 放行;有行 → 要求全部确认。
 * 净效果:两类项都是“渲染前放行、渲染后有牙”,S5 UI(自动渲染评审卡)落地前
 * done 不会被无端锁死;落地后门自动生效。
 */

import { and, eq, desc } from "drizzle-orm";
import { customAlphabet } from "nanoid";

import { getDb, schema } from "../db/index.js";
import { ownerScope } from "./access.js";
import {
  auditColumns,
  auditMigrations,
  resolveRuntimeMigrationsSource,
  resolveRuntimeSchemaSource,
  stripDiffMarkers,
} from "./migration-audit.js";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChecklistItemSource = "machine" | "human";
export type ChecklistItemState = "pass" | "fail" | "needs-human";

export interface ChecklistItem {
  key: string;
  label: string;
  source: ChecklistItemSource;
  /** Machine items: computed deterministically. Human items: 'needs-human'
   *  until confirmed (persisted state layered on top by `computeChecklistState`). */
  state: ChecklistItemState;
  /** Present on machine 'fail' items — precise detail for the red expand-out
   *  (e.g. the exact missing table/column names, 03 §2's "精确名单"). */
  detail?: string;
}

export interface ChecklistDiffMeta {
  /** Whether this diff (or the live full-audit fallback) shows a schema
   *  change at all — gates whether the two migration-audit items are
   *  included. */
  schemaChanged: boolean;
  missingTables: string[];
  missingColumns: string[];
  /** Whether the diff (or delivery context) shows migration-smoke evidence —
   *  heuristically, whether the diff touches db-migration.test.ts additively.
   *  `null` when there's no diff context to judge from at all (full-audit
   *  mode) — surfaces as 'needs-human' rather than a false 'fail'. */
  smokeEvidencePresent: boolean | null;
  /** Count of distinct `schema.X` tables referenced by an `insert(`/`update(`
   *  call in the diff's added lines — heuristic multi-table-write signal. */
  tablesWrittenCount: number;
}

// ---------------------------------------------------------------------------
// Pure: nature-driven checklist assembly (docs/sdlc-impl-f5-f10.md §2A)
// ---------------------------------------------------------------------------

const MIGRATION_AUDIT_KEY = "migration-audit";
const MIGRATION_SMOKE_KEY = "migration-smoke-evidence";
const TRANSACTION_WRAP_KEY = "transaction-wrap";
const OWNERSCOPE_KEY = "ownerscope-check";

/** reviewKey namespace for F6 checklist rows in `tracker_artifact_reviews`
 *  (docs/sdlc-impl-f5-f10.md §2C: "reviewKey 命名空间 checklist:<key>") — kept
 *  distinct from B5's pre-existing (unnamespaced) 审查三问 keys, which this
 *  module does not touch or duplicate. */
export function checklistReviewKey(key: string): string {
  return `checklist:${key}`;
}

/**
 * Assemble the nature/diff-driven checklist for one work item. Pure — no DB.
 *
 * Rules (03 §2 "内置必查项" + the s5-inbox.html R3 prototype, which is the
 * more concrete evidence for the "always-on" ownerScope item the terse doc
 * prose doesn't spell out — see this file's module docblock):
 *   - schema change (diffMeta.schemaChanged, or nature includes "数据") →
 *     "新表/新列 ↔ 迁移对账" (machine) + "迁移冒烟证据在场" (machine).
 *   - ≥2 distinct tables written (diffMeta.tablesWrittenCount) → "事务包裹"
 *     (human).
 *   - always → "ownerScope 贯穿新查询" (human) — cross-cutting architecture
 *     rule (CLAUDE.md "Architecture Contract"), independent of nature/diff.
 *
 * Deliberately does NOT include the pre-existing B5 审查三问 (设计遵循/边界
 * 处理/证据可信) — those remain a separate section with their own
 * (unnamespaced) reviewKeys, per the reviewKey-namespace clue in §2C and the
 * prototype's own two-section layout. See report for this call-out.
 */
export function assembleChecklist(
  nature: string[],
  diffMeta: ChecklistDiffMeta,
): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const schemaChanged = diffMeta.schemaChanged || nature.includes("数据");

  if (schemaChanged) {
    const migrationMissing = [
      ...diffMeta.missingTables,
      ...diffMeta.missingColumns,
    ];
    items.push({
      key: MIGRATION_AUDIT_KEY,
      label: "新表/新列 ↔ 迁移对账",
      source: "machine",
      state: migrationMissing.length === 0 ? "pass" : "fail",
      detail:
        migrationMissing.length === 0 ? undefined : migrationMissing.join(", "),
    });
    items.push({
      key: MIGRATION_SMOKE_KEY,
      label: "迁移冒烟证据在场",
      source: "machine",
      state:
        diffMeta.smokeEvidencePresent === null
          ? "needs-human"
          : diffMeta.smokeEvidencePresent
            ? "pass"
            : "fail",
    });
  }

  if (diffMeta.tablesWrittenCount >= 2) {
    items.push({
      key: TRANSACTION_WRAP_KEY,
      label: "事务包裹 —— 多表级联写",
      source: "human",
      state: "needs-human",
    });
  }

  items.push({
    key: OWNERSCOPE_KEY,
    label: "ownerScope 贯穿新查询",
    source: "human",
    state: "needs-human",
  });

  return items;
}

/** Count distinct `schema.X` tables referenced by an `insert(`/`update(` call
 *  in a diff's ADDED lines — heuristic signal for "multi-table cascade
 *  write" (03 §2's "diff 中 ≥2 表写点"). Pure. */
export function countDistinctTablesWritten(diffText: string): number {
  const added = stripDiffMarkers(diffText);
  const tables = new Set<string>();
  const re = /\b(?:insert|update)\(\s*schema\.(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(added))) tables.add(m[1]!);
  return tables.size;
}

/**
 * Compute `ChecklistDiffMeta` from an optional diff. With a diff: everything
 * is derived from the diff's own added lines (the code under review is an
 * un-merged branch — the currently-running tracker instance is `main` and
 * does NOT reflect it, so runtime introspection would be wrong here; see
 * migration-audit.ts's module docblock for the parallel reasoning on
 * `audit-migrations`). Without a diff: falls back to a live full-repo audit
 * via runtime introspection (a genuine, if coarser, health signal — see
 * `resolveRuntimeSchemaSource`/`resolveRuntimeMigrationsSource`).
 */
export async function computeDiffMeta(
  diff?: string,
): Promise<ChecklistDiffMeta> {
  if (diff) {
    const added = stripDiffMarkers(diff);
    const tableAudit = auditMigrations(added, added);
    const columnAudit = auditColumns(diff, added);
    const schemaChanged =
      tableAudit.tables.length > 0 ||
      columnAudit.columns.length > 0 ||
      /schema\.ts|server\/db\/schema/.test(diff);
    const smokeEvidencePresent =
      /db-migration\.test\.ts/.test(diff) &&
      /^\+.*\b(expect|toBe|has)\(/m.test(diff);
    return {
      schemaChanged,
      missingTables: tableAudit.missing,
      missingColumns: columnAudit.missing,
      smokeEvidencePresent,
      tablesWrittenCount: countDistinctTablesWritten(diff),
    };
  }

  // Full-audit mode: judge the CURRENTLY RUNNING instance's own consistency.
  const schemaSource = await resolveRuntimeSchemaSource();
  const migrationsSource = await resolveRuntimeMigrationsSource();
  const tableAudit = auditMigrations(schemaSource, migrationsSource);
  return {
    schemaChanged: tableAudit.missing.length > 0,
    missingTables: tableAudit.missing,
    missingColumns: [],
    // No diff/PR context to judge delivery-time evidence from — conservative
    // 'needs-human' rather than a false 'fail' for every ticket.
    smokeEvidencePresent: null,
    tablesWrittenCount: 0,
  };
}

// ---------------------------------------------------------------------------
// DB-touching resolvers (dependency-injected `db`, mirrors dispatch-gate.ts)
// ---------------------------------------------------------------------------

export type ChecklistAnchorKind = "sprint-artifact" | "synthetic";

export interface ChecklistAnchor {
  artifactId: string;
  version: number;
  /** How this anchor is backed — see module docblock. Guard-time
   *  "review-started" detection differs by kind (sprint-artifact rows carry
   *  their own existence signal; synthetic anchors use "≥1 persisted row"). */
  kind: ChecklistAnchorKind;
}

interface ChecklistWorkItem {
  id: string;
  sprintId?: string | null;
}

function syntheticAnchor(workItemId: string): ChecklistAnchor {
  return {
    artifactId: `wi-review:${workItemId}`,
    version: 1,
    kind: "synthetic",
  };
}

/**
 * READ-ONLY resolve of a work item's review-checklist anchor.
 *   - sprint-internal (has sprintId): latest `tracker_sprint_artifacts` row for
 *     `docKey=review:<id>`; null when none exists yet (review never rendered).
 *   - sprint-external (no sprintId): the deterministic synthetic anchor (always
 *     resolvable — see module docblock).
 * NEVER creates a row (that's `resolveOrCreateChecklistAnchor`'s job).
 */
export async function resolveChecklistAnchor(
  db: ReturnType<typeof getDb>,
  workItem: ChecklistWorkItem,
): Promise<ChecklistAnchor | null> {
  if (!workItem.sprintId) return syntheticAnchor(workItem.id);
  const docKey = `review:${workItem.id}`;
  const latest = (
    await db
      .select({
        id: schema.sprintArtifacts.id,
        version: schema.sprintArtifacts.version,
      })
      .from(schema.sprintArtifacts)
      .where(
        and(
          eq(schema.sprintArtifacts.sprintId, workItem.sprintId),
          eq(schema.sprintArtifacts.docKey, docKey),
          ownerScope(schema.sprintArtifacts),
        ),
      )
      .orderBy(desc(schema.sprintArtifacts.version))
      .limit(1)
  )[0];
  return latest
    ? {
        artifactId: latest.id,
        version: latest.version,
        kind: "sprint-artifact",
      }
    : null;
}

/**
 * Resolve the anchor for a RENDER (write) pass, lazily creating it when the
 * sprint-internal item has no review sprint-artifact yet (F-2). For
 * sprint-external items the synthetic anchor already "exists" — nothing to
 * create. See module docblock for why the lazy sprint-artifact is a direct
 * INSERT rather than the `create-sprint-artifact` action.
 */
export async function resolveOrCreateChecklistAnchor(
  db: ReturnType<typeof getDb>,
  ownerEmail: string,
  orgId: string | null,
  workItem: ChecklistWorkItem,
): Promise<ChecklistAnchor> {
  const existing = await resolveChecklistAnchor(db, workItem);
  if (existing) return existing;

  // Only reached for a sprint-internal item with no review artifact yet.
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insert(schema.sprintArtifacts).values({
    id,
    sprintId: workItem.sprintId!,
    docKey: `review:${workItem.id}`,
    kind: "评审",
    name: `评审核对清单锚点 · ${workItem.id}`,
    version: 1,
    supersedes: null,
    producedByKind: "agent",
    content: "",
    contentRef: null,
    createdAt: now,
    ownerEmail,
    orgId,
    visibility: "private",
  });
  return { artifactId: id, version: 1, kind: "sprint-artifact" };
}

/** Read persisted checklist rows for an anchor, keyed by the checklist item
 *  `key` (namespace-stripped back off, so callers work with the same plain
 *  keys `assembleChecklist` emits). */
export async function loadPersistedChecklistState(
  db: ReturnType<typeof getDb>,
  anchor: ChecklistAnchor,
): Promise<Map<string, boolean>> {
  const rows = await db
    .select({
      reviewKey: schema.artifactReviews.reviewKey,
      checked: schema.artifactReviews.checked,
    })
    .from(schema.artifactReviews)
    .where(
      and(
        eq(schema.artifactReviews.artifactId, anchor.artifactId),
        eq(schema.artifactReviews.version, anchor.version),
        ownerScope(schema.artifactReviews),
      ),
    );
  const state = new Map<string, boolean>();
  for (const row of rows) {
    if (!row.reviewKey.startsWith("checklist:")) continue;
    const key = row.reviewKey.slice("checklist:".length);
    state.set(key, row.checked === 1);
  }
  return state;
}

/** Upsert one checklist row for `anchor` (write path only). `reviewer` is
 *  "system" for machine items, the confirming user for human ones. For human
 *  placeholders, `onlyIfAbsent` prevents clobbering a prior confirmation. */
async function upsertChecklistRow(
  db: ReturnType<typeof getDb>,
  ownerEmail: string,
  orgId: string | null,
  anchor: ChecklistAnchor,
  item: ChecklistItem,
  checked: boolean,
  onlyIfAbsent: boolean,
): Promise<void> {
  const reviewKey = checklistReviewKey(item.key);
  const now = new Date().toISOString();
  const existing = (
    await db
      .select({ id: schema.artifactReviews.id })
      .from(schema.artifactReviews)
      .where(
        and(
          eq(schema.artifactReviews.artifactId, anchor.artifactId),
          eq(schema.artifactReviews.version, anchor.version),
          eq(schema.artifactReviews.reviewKey, reviewKey),
          ownerScope(schema.artifactReviews),
        ),
      )
      .limit(1)
  )[0];

  if (existing) {
    if (onlyIfAbsent) return; // human placeholder — never clobber a confirmation.
    await db
      .update(schema.artifactReviews)
      .set({ checked: checked ? 1 : 0, reviewer: "system", updatedAt: now })
      .where(eq(schema.artifactReviews.id, existing.id));
    return;
  }

  await db.insert(schema.artifactReviews).values({
    // Unique id: (artifactId, version, reviewKey) already has a UNIQUE index,
    // so a random nanoid is sufficient AND collision-safe — the deterministic
    // `chk_<first8>_<key>` scheme this replaced could collide when two anchor
    // artifactIds share a first-8-char prefix (R3 review F-8).
    id: nanoid(),
    artifactId: anchor.artifactId,
    version: anchor.version,
    reviewKey,
    checked: checked ? 1 : 0,
    reviewer: "system",
    createdAt: now,
    updatedAt: now,
    ownerEmail,
    orgId,
    visibility: "private",
  });
}

/** Write-through sync of MACHINE items' computed state (pass→checked,
 *  fail/needs-human→unchecked). RENDER path only — never called by the guard
 *  (F-1). Human items are never machine-written here (they get placeholders
 *  via `syncHumanPlaceholders`, and real confirmations via
 *  `set-artifact-review`). */
export async function syncMachineChecklistItems(
  db: ReturnType<typeof getDb>,
  ownerEmail: string,
  orgId: string | null,
  anchor: ChecklistAnchor,
  items: ChecklistItem[],
): Promise<void> {
  for (const item of items) {
    if (item.source !== "machine") continue;
    await upsertChecklistRow(
      db,
      ownerEmail,
      orgId,
      anchor,
      item,
      item.state === "pass",
      /* onlyIfAbsent */ false,
    );
  }
}

/** Persist HUMAN items as unchecked placeholders (RENDER path only) so the
 *  read-only guard's "every persisted row checked=1" check actually requires
 *  each human confirmation — an unconfirmed human item that had no row would
 *  otherwise be invisible to the guard. Insert-if-absent: never clobbers a
 *  human's prior confirmation. */
export async function syncHumanPlaceholders(
  db: ReturnType<typeof getDb>,
  ownerEmail: string,
  orgId: string | null,
  anchor: ChecklistAnchor,
  items: ChecklistItem[],
): Promise<void> {
  for (const item of items) {
    if (item.source !== "human") continue;
    await upsertChecklistRow(
      db,
      ownerEmail,
      orgId,
      anchor,
      item,
      /* checked */ false,
      /* onlyIfAbsent */ true,
    );
  }
}

export interface ChecklistState {
  anchor: ChecklistAnchor | null;
  items: Array<ChecklistItem & { checked: boolean }>;
  /** True when every assembled item is checked=true. */
  complete: boolean;
}

/**
 * RENDER path: assemble the checklist for a work item, lazily create its
 * anchor, persist machine judgments + human placeholders, and report state.
 * Used by `actions/get-review-checklist.ts`. This is the ONLY write path
 * (the done guard uses the read-only `isChecklistComplete` instead — F-1).
 */
export async function computeChecklistState(
  db: ReturnType<typeof getDb>,
  ownerEmail: string,
  orgId: string | null,
  workItem: { id: string; sprintId?: string | null; nature: string[] },
  diff?: string,
): Promise<ChecklistState> {
  const diffMeta = await computeDiffMeta(diff);
  const items = assembleChecklist(workItem.nature, diffMeta);
  const anchor = await resolveOrCreateChecklistAnchor(
    db,
    ownerEmail,
    orgId,
    workItem,
  );

  await syncMachineChecklistItems(db, ownerEmail, orgId, anchor, items);
  await syncHumanPlaceholders(db, ownerEmail, orgId, anchor, items);

  const persisted = await loadPersistedChecklistState(db, anchor);
  const withState = items.map((i) => ({
    ...i,
    checked: persisted.get(i.key) === true,
  }));
  const complete = withState.every((i) => i.checked);
  return { anchor, items: withState, complete };
}

/**
 * GUARD path (F-1): read-only completeness check for the `transition-work-item`
 * done branch. NEVER assembles machine states, NEVER writes a row — it only
 * reads what the render path persisted. See the module docblock's "两条严格
 * 分离的路径" and "守卫'评审是否已发生'的判定" sections for the full rationale
 * behind each branch below.
 */
export async function isChecklistComplete(
  db: ReturnType<typeof getDb>,
  workItem: ChecklistWorkItem,
): Promise<boolean> {
  const anchor = await resolveChecklistAnchor(db, workItem);
  // sprint-internal with no review artifact → review never rendered → pass.
  if (!anchor) return true;

  const persisted = await loadPersistedChecklistState(db, anchor);
  if (persisted.size === 0) {
    // No checklist rows yet. Synthetic (sprint-external) anchors have no other
    // existence signal, so zero rows = review never rendered → pass. A real
    // sprint-artifact anchor with zero rows is a bare anchor whose checklist
    // was never populated (can't happen in production — render persists atomic
    // with the anchor; only a hand-inserted test anchor hits this) → fail-closed.
    return anchor.kind === "synthetic";
  }
  for (const checked of persisted.values()) {
    if (!checked) return false;
  }
  return true;
}
