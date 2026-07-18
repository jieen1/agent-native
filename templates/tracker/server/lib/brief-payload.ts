// R4b.3 — planning-domain payload contract (docs/sdlc-product-design/
// r4-workflow-families-planning-skills.md §5.5). Assembles the structured
// `suggestedInputs` a dispatch should carry for a work item, keyed by the
// L1-suggested template name (workflow-routing.ts), from the item's OWN
// sprint-artifact briefs — replacing the raw work-item description prose the
// brain previously had to rely on alone. Whitelist per §5.5's table:
//
//   issue-pipeline / quick-task / hotfix → brief:{itemKey} + shared-brief
//     (+ ui-spec screen summaries — already embedded inline by
//     extract-briefs.ts's own "## 关联屏幕规格摘要" section, nothing extra
//     to fetch). FOREVER FORBIDDEN by §5.5: tech-design/sprint-doc full
//     text, another item's brief — never read those into this payload.
//   sdlc-gap-analysis → extract-goal-metrics.ts's own parser, reused
//     directly (action-to-action, the same reuse convention extract-briefs.ts
//     already uses on create-sprint-artifact.ts) for `inputs.goal`/
//     `inputs.goalMetrics`. `inputs.diffSummary` is a run-time artifact
//     (git diff once dev work exists) — never fabricated here.
//   sdlc-ui-build → ui-spec full text for `inputs.uiSpec`. `designSystemId`
//     is not a stored field anywhere in this app (verified: zero hits) — never
//     fabricated; omitted so the brain must supply a real one itself.
//
// sdlc-verify's row ("test-plan 场景节，结构化提取") has no existing parser
// to build on and isn't reachable through resolveWorkflowRule's own routing
// table today (DEFAULT_WORKFLOW_RULES never selects sdlc-verify — it's a
// sprint-level integration check the brain runs on its own initiative, not a
// per-item dispatch) — left as a documented remaining gap rather than a
// speculative parser against an unconfirmed artifact format.
//
// Best-effort throughout: every branch returns {} (never throws) when the
// item has no sprint, no matching artifact exists yet, or the resolved
// template isn't one of the whitelisted rows — dispatch-to-orchestrator.ts
// falls back to its pre-existing behavior (raw description prose only) in
// every one of those cases.

import { and, desc, eq } from "drizzle-orm";

import { parseSuccessMetrics } from "../../actions/extract-goal-metrics.js";
import { getDb, schema } from "../db/index.js";
import { ownerScope } from "./access.js";

const BRIEF_SPEC_TEMPLATES = new Set([
  "sdlc-issue-pipeline",
  "quick-task",
  "hotfix",
]);

async function latestArtifactContent(
  db: ReturnType<typeof getDb>,
  sprintId: string,
  docKey: string,
): Promise<string | undefined> {
  const row = (
    await db
      .select({ content: schema.sprintArtifacts.content })
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
  return row?.content;
}

/** Reverses extract-briefs.ts's own "## 涉及文件" table generation
 *  (`| \`path\` | OP | note |`, header "| 文件路径 | 操作 | 说明 |") back
 *  into a scopeGlobs string array — §5.5's `brief.touches → inputs.scopeGlobs`. */
export function extractScopeGlobsFromBrief(briefContent: string): string[] {
  const lines = briefContent.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === "## 涉及文件") {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return [];

  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!.trim())) {
      end = i;
      break;
    }
  }

  const rows: string[][] = [];
  for (const raw of lines.slice(start, end)) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    if (/^\|[\s:|-]+\|$/.test(line)) continue; // separator row
    rows.push(
      line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim()),
    );
  }
  return rows
    .slice(1) // drop header row
    .map((r) => (r[0] ?? "").replace(/`/g, "").trim())
    .filter(Boolean);
}

/** Combines an item's own brief with the sprint's shared conventions into the
 *  single `inputs.spec` text these templates' DAG nodes actually read — never
 *  the OTHER whitelist-forbidden artifacts (tech-design/sprint-doc full text,
 *  other items' briefs). */
export function buildCombinedSpec(
  briefContent: string,
  sharedBriefContent: string | undefined,
): string {
  const parts = [briefContent.trim()];
  if (sharedBriefContent && sharedBriefContent.trim()) {
    parts.push(
      "",
      "---",
      "",
      "## 共享约定 (shared-brief)",
      "",
      sharedBriefContent.trim(),
    );
  }
  return parts.join("\n") + "\n";
}

export interface DispatchPayloadArgs {
  sprintId: string;
  itemKey: string;
  templateName: string;
}

/**
 * Resolve the §5.5 payload for one dispatch, keyed by the L1-suggested
 * template name. Never throws; returns {} whenever the relevant artifact
 * doesn't exist yet or `templateName` isn't one of the whitelisted rows.
 */
export async function resolveDispatchPayload(
  db: ReturnType<typeof getDb>,
  args: DispatchPayloadArgs,
): Promise<Record<string, unknown>> {
  if (BRIEF_SPEC_TEMPLATES.has(args.templateName)) {
    const briefContent = await latestArtifactContent(
      db,
      args.sprintId,
      `brief:${args.itemKey}`,
    );
    if (!briefContent) return {};

    const sharedBriefContent = await latestArtifactContent(
      db,
      args.sprintId,
      "shared-brief",
    );
    const scopeGlobs = extractScopeGlobsFromBrief(briefContent);
    return {
      spec: buildCombinedSpec(briefContent, sharedBriefContent),
      ...(scopeGlobs.length > 0 ? { scopeGlobs } : {}),
    };
  }

  if (args.templateName === "sdlc-gap-analysis") {
    const sprintDocContent = await latestArtifactContent(
      db,
      args.sprintId,
      "sprint-doc",
    );
    if (!sprintDocContent) return {};

    const sprintRow = (
      await db
        .select({ goal: schema.sprints.goal })
        .from(schema.sprints)
        .where(
          and(eq(schema.sprints.id, args.sprintId), ownerScope(schema.sprints)),
        )
        .limit(1)
    )[0];
    const { metrics } = parseSuccessMetrics(sprintDocContent);
    return {
      goal: sprintRow?.goal ?? "",
      ...(metrics.length > 0 ? { goalMetrics: metrics } : {}),
    };
  }

  if (args.templateName === "sdlc-ui-build") {
    const uiSpecContent = await latestArtifactContent(
      db,
      args.sprintId,
      "ui-spec",
    );
    if (!uiSpecContent) return {};
    return { uiSpec: uiSpecContent };
  }

  return {};
}
