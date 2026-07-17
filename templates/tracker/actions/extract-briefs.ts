import { createHash } from "node:crypto";

import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { and, eq, desc } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import { estimateScale } from "../server/lib/scale-estimate.js";
import {
  parseTechDesignItems,
  parseFileMatrix,
  parseApiTable,
  buildDependencyGraph,
  computeWaves,
  extractSection,
  type DependencyEdge,
} from "../server/lib/tech-design-parse.js";
import {
  parseUiSpecScreens,
  summarizeScreen,
} from "../server/lib/ui-spec-parse.js";
import createSprintArtifact from "./create-sprint-artifact.js";

// R4b.1 `extract-briefs` — docs/sdlc-product-design/
// r4-workflow-families-planning-skills.md §5.3. Deterministic, zero-LLM:
// parses the latest tech-design artifact and produces N `brief:{itemKey}` +
// one `shared-brief` + one `briefs-index` sprint artifact. Reuses
// `create-sprint-artifact`'s own versioning/supersedes/human-protection
// logic by calling its exported action directly (same pattern the test
// suite uses to invoke actions) rather than re-implementing that logic here.

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function latestArtifact(
  db: ReturnType<typeof getDb>,
  sprintId: string,
  docKey: string,
): Promise<{ id: string; version: number; content: string } | undefined> {
  return (
    await db
      .select({
        id: schema.sprintArtifacts.id,
        version: schema.sprintArtifacts.version,
        content: schema.sprintArtifacts.content,
      })
      .from(schema.sprintArtifacts)
      .where(
        and(
          eq(schema.sprintArtifacts.sprintId, sprintId),
          eq(schema.sprintArtifacts.docKey, docKey),
          ownerScope(schema.sprintArtifacts),
        ),
      )
      .orderBy(desc(schema.sprintArtifacts.version))
      .limit(1)
  )[0];
}

interface WriteResult {
  id: string;
  version: number;
  skipped: boolean;
}

/** Idempotent create: skip creating a new version when the content hash
 *  matches the latest existing version for this docKey (§5.3 "幂等"). */
async function writeIfChanged(
  db: ReturnType<typeof getDb>,
  sprintId: string,
  docKey: string,
  kind: string,
  name: string,
  content: string,
): Promise<WriteResult> {
  const existing = await latestArtifact(db, sprintId, docKey);
  if (existing && contentHash(existing.content) === contentHash(content)) {
    return { id: existing.id, version: existing.version, skipped: true };
  }
  const created = await createSprintArtifact.run({
    sprintId,
    docKey,
    kind,
    name,
    producedByKind: "agent",
    content,
  });
  return { id: created.id, version: created.version, skipped: false };
}

function edgeLabel(e: DependencyEdge): string {
  return `${e.itemKey} → ${e.dependsOn} (${e.source})`;
}

export default defineAction({
  description:
    "R4b.1 §5.3: deterministically extract briefs from the latest tech-design artifact. " +
    "Requires design-signoff approved for that exact version, or force=true (leaves a " +
    "trace in briefs-index). Produces brief:{itemKey} per §4 work-item section, one " +
    "shared-brief (§2/§5/§6/§8), and one briefs-index (dependency Wave layering + missing " +
    "items). Idempotent per docKey (content-hash match skips a new version). Flags any " +
    "brief whose estimateScale() verdict is split-required and writes back the work item's " +
    "scaleEstimate — use split-work-item on flagged items before dispatch.",
  schema: z.object({
    sprintId: z.string().min(1).describe("Sprint id"),
    force: z
      .boolean()
      .optional()
      .describe(
        "Bypass a missing/unapproved design-signoff for the current tech-design version. " +
          "Leaves a visible trace in the briefs-index artifact — use only when the human " +
          "explicitly asked to skip signoff.",
      ),
  }),
  http: { method: "POST" },
  audit: {
    target: (args) => ({ type: "sprint", id: args.sprintId }),
    summary: (args, result) => {
      const r = result as { briefs?: unknown[]; forced?: boolean } | undefined;
      return `Extracted ${r?.briefs?.length ?? 0} brief(s) for sprint ${args.sprintId}${r?.forced ? " (forced, signoff bypassed)" : ""}`;
    },
  },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId() ?? null;
    const db = getDb();

    const sprint = (
      await db
        .select({ id: schema.sprints.id })
        .from(schema.sprints)
        .where(
          and(eq(schema.sprints.id, args.sprintId), ownerScope(schema.sprints)),
        )
        .limit(1)
    )[0];
    if (!sprint) throw new Error("Sprint not found");

    const techDesign = await latestArtifact(db, args.sprintId, "tech-design");
    if (!techDesign) {
      throw new Error(
        "未找到 sprint 的 tech-design 产物（docKey=tech-design）：extract-briefs 需要先完成技术设计",
      );
    }

    const approvals = await db
      .select()
      .from(schema.approvals)
      .where(
        and(
          ownerScope(schema.approvals),
          eq(schema.approvals.sprintId, args.sprintId),
          eq(schema.approvals.gateKey, "design-signoff"),
          eq(schema.approvals.status, "approved"),
        ),
      );
    const validApproval = approvals.find(
      (a) => a.anchorArtifactId === techDesign.id && !a.staleAt,
    );
    const designSignoffApproved = !!validApproval;

    if (!designSignoffApproved && args.force !== true) {
      const err = new Error(
        `design-signoff 未批准：tech-design v${techDesign.version} 尚未通过签核，无法提取 briefs。` +
          "传入 force=true 可强制提取（将在 briefs-index 产物中留痕）。",
      );
      (err as Error & { code?: string }).code = "design-signoff-required";
      throw err;
    }
    const forced = !designSignoffApproved && args.force === true;

    const items = parseTechDesignItems(techDesign.content);
    if (items.length === 0) {
      throw new Error(
        "tech-design §4 未解析出任何「### §4.N {itemKey} · {标题}」小节，无法提取 briefs",
      );
    }

    const apiRows = parseApiTable(techDesign.content);
    const fileRows = parseFileMatrix(techDesign.content);
    const edges = buildDependencyGraph(items, apiRows, fileRows);
    const itemKeys = items.map((i) => i.itemKey);
    const { waves, cycleEdges, missingItems } = computeWaves(itemKeys, edges);

    if (cycleEdges.length > 0) {
      throw new Error(
        `briefs 依赖图存在环，无法拓扑分层为 Wave 顺序: ${cycleEdges.map(edgeLabel).join(", ")}`,
      );
    }

    const workItemRows = await db
      .select()
      .from(schema.workItems)
      .where(
        and(
          eq(schema.workItems.sprintId, args.sprintId),
          ownerScope(schema.workItems),
        ),
      );
    const workItemByKey = new Map(workItemRows.map((w) => [w.itemKey, w]));

    const uiSpecArtifact = await latestArtifact(db, args.sprintId, "ui-spec");
    const uiSpecScreens = uiSpecArtifact
      ? parseUiSpecScreens(uiSpecArtifact.content)
      : [];
    const screenById = new Map(uiSpecScreens.map((s) => [s.id, s]));

    const briefs: Array<{
      itemKey: string;
      artifactId: string;
      version: number;
      skipped: boolean;
      scaleVerdict: "ok" | "split-required";
      scaleFlagged: boolean;
      workItemFound: boolean;
    }> = [];
    const scaleWarnings: Array<{
      itemKey: string;
      files: number;
      crossLifecycle: boolean;
      signals: string[];
    }> = [];

    for (const item of items) {
      const relatedFiles = fileRows.filter((r) => r.itemKey === item.itemKey);
      const relatedApi = apiRows.filter(
        (r) => r.producer === item.itemKey || r.consumer === item.itemKey,
      );
      const screenRefs = [
        ...new Set([...item.body.matchAll(/\bS\d+\b/g)].map((m) => m[0])),
      ];
      const screenSummaries = screenRefs
        .map((id) => screenById.get(id))
        .filter((s): s is NonNullable<typeof s> => !!s)
        .map(summarizeScreen);

      const parts = [
        `# Brief: ${item.itemKey} · ${item.title}`,
        "",
        item.body,
        "",
      ];
      if (item.dependsOn.length > 0) {
        parts.push("## 依赖", "", ...item.dependsOn.map((d) => `- ${d}`), "");
      }
      if (relatedFiles.length > 0) {
        parts.push(
          "## 涉及文件",
          "",
          "| 文件路径 | 操作 | 说明 |",
          "| --- | --- | --- |",
          ...relatedFiles.map(
            (r) => `| \`${r.path}\` | ${r.operation} | ${r.note} |`,
          ),
          "",
        );
      }
      if (relatedApi.length > 0) {
        parts.push(
          "## 相关 API",
          "",
          "| 方法 | 路径 | 生产方 | 消费方 | 说明 |",
          "| --- | --- | --- | --- | --- |",
          ...relatedApi.map(
            (r) =>
              `| ${r.method} | ${r.path} | ${r.producer} | ${r.consumer} | ${r.note} |`,
          ),
          "",
        );
      }
      if (screenSummaries.length > 0) {
        parts.push("## 关联屏幕规格摘要", "", ...screenSummaries, "");
      }
      const body = parts.join("\n").trim() + "\n";

      const docKey = `brief:${item.itemKey}`;
      const written = await writeIfChanged(
        db,
        args.sprintId,
        docKey,
        "Brief",
        `Brief · ${item.itemKey}`,
        body,
      );

      const scale = estimateScale(body);
      const scaleFlagged = scale.verdict === "split-required";
      const workItem = workItemByKey.get(item.itemKey);
      if (scaleFlagged) {
        if (workItem) {
          const at = new Date().toISOString();
          await db
            .update(schema.workItems)
            .set({ scaleEstimate: JSON.stringify({ ...scale, at }) })
            .where(eq(schema.workItems.id, workItem.id));
        }
        scaleWarnings.push({
          itemKey: item.itemKey,
          files: scale.files,
          crossLifecycle: scale.crossLifecycle,
          signals: scale.signals,
        });
      }

      briefs.push({
        itemKey: item.itemKey,
        artifactId: written.id,
        version: written.version,
        skipped: written.skipped,
        scaleVerdict: scale.verdict,
        scaleFlagged,
        workItemFound: !!workItem,
      });
    }

    const sharedParts: string[] = [];
    for (const n of [2, 5, 6, 8]) {
      const section = extractSection(techDesign.content, n);
      if (section && section.trim())
        sharedParts.push(`## §${n}`, "", section.trim(), "");
    }
    const sharedBody = sharedParts.join("\n").trim() + "\n";
    const sharedBrief = await writeIfChanged(
      db,
      args.sprintId,
      "shared-brief",
      "共享约定",
      "Shared Brief",
      sharedBody,
    );

    const indexParts: string[] = [
      "# Briefs Index",
      "",
      `- 共 ${items.length} 个 brief`,
      `- design-signoff: ${
        designSignoffApproved
          ? "已批准"
          : forced
            ? "未批准（已 force=true 强制提取）"
            : "未批准"
      }`,
    ];
    if (forced) {
      indexParts.push(
        `- ⚠️ 强制提取留痕：design-signoff 在 tech-design v${techDesign.version} 上未批准或已失效，本次结果未经签核门`,
      );
    }
    indexParts.push("", "## Wave 顺序", "");
    if (waves.length === 0) indexParts.push("- 无");
    waves.forEach((w, i) =>
      indexParts.push(`- Wave ${i + 1}: ${w.join(", ")}`),
    );
    indexParts.push("", "## 依赖", "");
    if (edges.length === 0) indexParts.push("- 无");
    edges.forEach((e) => indexParts.push(`- ${edgeLabel(e)}`));
    indexParts.push("", "## 缺失项（被引用但无 §4 小节）", "");
    if (missingItems.length === 0) indexParts.push("- 无");
    missingItems.forEach((m) => indexParts.push(`- ${m}`));
    indexParts.push("", "## 规模告警", "");
    if (scaleWarnings.length === 0) indexParts.push("- 无");
    scaleWarnings.forEach((w) =>
      indexParts.push(
        `- ${w.itemKey}: split-required（files=${w.files}, crossLifecycle=${w.crossLifecycle}）—— 使用 split-work-item 拆分后再派发`,
      ),
    );

    const indexBody = indexParts.join("\n").trim() + "\n";
    const briefsIndex = await writeIfChanged(
      db,
      args.sprintId,
      "briefs-index",
      "索引",
      "Briefs Index",
      indexBody,
    );

    return {
      sprintId: args.sprintId,
      techDesignVersion: techDesign.version,
      designSignoffApproved,
      forced,
      briefs,
      sharedBrief,
      briefsIndex: {
        ...briefsIndex,
        waves,
        missingItems,
        dependencies: edges,
      },
      scaleWarnings,
    };
  },
});
