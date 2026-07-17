import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, eq, desc, sql } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import {
  assembleArtifactGates,
  allMachineGatesPass,
} from "../server/lib/artifact-gates.js";

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

export default defineAction({
  description:
    "R4b.1 dual-track quality gate, deterministic half: parse the latest sprintId+docKey " +
    "artifact and return a docKey-specific ChecklistItem[] (machine|human source, " +
    "pass|fail|needs-human state) — same shape as get-review-checklist/review-checklist.ts. " +
    "Zero LLM. ui-spec's rule set also reads the latest sprint-doc; tech-design's rule set " +
    "also reads the latest ui-spec + the sprint's work-item count.",
  schema: z.object({
    sprintId: z.string().min(1).describe("Sprint id"),
    docKey: z
      .string()
      .min(1)
      .describe(
        "Artifact docKey to gate: sprint-doc | test-plan | ui-spec | tech-design | " +
          "brainstorm-notes | brief:{itemKey} | shared-brief | briefs-index | ... " +
          "(docKeys with no §5.2 rule set get a placeholder non-empty-content check)",
      ),
  }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

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

    const artifact = await latestArtifact(db, args.sprintId, args.docKey);
    if (!artifact) {
      return {
        sprintId: args.sprintId,
        docKey: args.docKey,
        artifactId: null,
        version: null,
        items: [],
        complete: false,
        note: `尚无 docKey="${args.docKey}" 的产物版本`,
      };
    }

    let sprintDocContent: string | undefined;
    let uiSpecContent: string | undefined;
    let sprintWorkItemCount: number | undefined;

    if (args.docKey === "ui-spec") {
      sprintDocContent = (await latestArtifact(db, args.sprintId, "sprint-doc"))
        ?.content;
    }
    if (args.docKey === "tech-design") {
      uiSpecContent = (await latestArtifact(db, args.sprintId, "ui-spec"))
        ?.content;
      const [row] = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.workItems)
        .where(
          and(
            eq(schema.workItems.sprintId, args.sprintId),
            ownerScope(schema.workItems),
          ),
        );
      sprintWorkItemCount = Number(row?.count) || 0;
    }

    const items = assembleArtifactGates(args.docKey, artifact.content, {
      sprintDocContent,
      uiSpecContent,
      sprintWorkItemCount,
    });

    // NOTE: unlike review-checklist.ts, this action has no persistence/
    // override layer for its (rare) `needs-human` fallback items — those
    // only appear when required cross-artifact context is missing (e.g.
    // ui-spec gated without a sprint-doc yet) and are informational only.
    // `complete` reflects the machine-sourced items alone — the design's
    // "确定性项不可覆盖" half of the dual-track gate; the self-assessment
    // half (artifact's own "## 质量门自评" section) is a separate track the
    // UI merges in, not this action's concern.
    return {
      sprintId: args.sprintId,
      docKey: args.docKey,
      artifactId: artifact.id,
      version: artifact.version,
      items,
      complete: allMachineGatesPass(items),
    };
  },
});
