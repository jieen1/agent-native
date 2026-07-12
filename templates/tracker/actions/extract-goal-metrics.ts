import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, eq, desc } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

// ---------------------------------------------------------------------------
// Pure-function exports — testable without any DB / HTTP context.
// ---------------------------------------------------------------------------

export interface GoalMetric {
  id: string;
  type: "Leading" | "Lagging";
  statement: string;
  signal: string;
}

export interface ParsedSuccessMetrics {
  metrics: GoalMetric[];
  warnings: string[];
}

const HEADING_RE = /^#{1,6}\s/;
const METRIC_RE =
  /^[-*]\s*M(\d+)\s*\|\s*(Leading|Lagging)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*$/;

/**
 * Find the "Success Metrics" section in a markdown document.
 * Returns the array of lines between that heading and the next heading (or EOF).
 * Returns null if the heading is not present.
 */
export function extractSuccessMetricsSection(
  content: string,
): string[] | null {
  const lines = content.split("\n");
  let startIdx: number | undefined;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (
      HEADING_RE.test(trimmed) &&
      trimmed.replace(/^#+\s*/, "").toLowerCase() === "success metrics"
    ) {
      startIdx = i;
      break;
    }
  }

  if (startIdx === undefined) return null;

  const sectionLines: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (HEADING_RE.test(trimmed)) break;
    sectionLines.push(trimmed);
  }

  return sectionLines;
}

/**
 * Parse the full document content into metrics + warnings.
 * Deterministic, zero side-effects.
 */
export function parseSuccessMetrics(content: string): ParsedSuccessMetrics {
  const section = extractSuccessMetricsSection(content);

  if (section === null) {
    return {
      metrics: [],
      warnings: ["Success Metrics 节未找到"],
    };
  }

  const metrics: GoalMetric[] = [];
  const warnings: string[] = [];

  for (const rawLine of section) {
    const line = rawLine.trim();
    if (line === "") continue;

    const m = line.match(METRIC_RE);
    if (m) {
      metrics.push({
        id: "M" + m[1]!,
        type: m[2]! as "Leading" | "Lagging",
        statement: m[3]!.trim(),
        signal: m[4]!.trim(),
      });
    } else {
      // Strip leading list marker (- or *) from non-matching lines
      warnings.push(line.replace(/^[-*]\s*/, ""));
    }
  }

  return { metrics, warnings };
}

/**
 * Assert that an artifact row was found; throw a clear error otherwise.
 */
export function assertArtifactFound<T>(
  artifact: T | undefined | null,
  sprintId: string,
): T {
  if (artifact == null) {
    throw new Error(
      "未找到 sprint " + sprintId + " 的 sprint-doc 产物（docKey=sprint-doc）",
    );
  }
  return artifact;
}

// ---------------------------------------------------------------------------
// Action definition
// ---------------------------------------------------------------------------

export default defineAction({
  description:
    "Deterministically extract the sprint goal and M-numbered success metrics " +
    "from the latest sprint-doc artifact. Zero LLM — pure text parsing.",
  schema: z.object({
    sprintId: z.string().min(1).describe("Sprint id"),
  }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

    const db = getDb();

    // 1) Verify sprint exists & readable
    const sprint = (
      await db
        .select({ id: schema.sprints.id, goal: schema.sprints.goal })
        .from(schema.sprints)
        .where(
          and(
            eq(schema.sprints.id, args.sprintId),
            ownerScope(schema.sprints),
          ),
        )
        .limit(1)
    )[0];
    if (!sprint) throw new Error("Sprint not found");

    // 2) Fetch latest sprint-doc artifact
    const artifactRow = (
      await db
        .select({ content: schema.sprintArtifacts.content })
        .from(schema.sprintArtifacts)
        .where(
          and(
            eq(schema.sprintArtifacts.sprintId, args.sprintId),
            eq(schema.sprintArtifacts.docKey, "sprint-doc"),
            ownerScope(schema.sprintArtifacts),
          ),
        )
        .orderBy(desc(schema.sprintArtifacts.version))
        .limit(1)
    )[0];

    const artifact = assertArtifactFound(artifactRow, args.sprintId);

    // 3) Parse
    const { metrics, warnings } = parseSuccessMetrics(artifact.content);

    return {
      goal: sprint.goal ?? "",
      metrics,
      warnings,
    };
  },
});