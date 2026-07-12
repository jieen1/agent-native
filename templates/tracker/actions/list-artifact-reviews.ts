import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

// ---------------------------------------------------------------------------
// Pure helpers — testable without any DB / HTTP context.
// ---------------------------------------------------------------------------

export interface ArtifactVersionRow {
  id: string;
  version: number;
}

/**
 * Pick the artifact row with the highest version from a list.
 * Returns undefined if the list is empty.
 */
export function pickLatestArtifactVersion(
  rows: ArtifactVersionRow[],
): ArtifactVersionRow | undefined {
  if (!rows || rows.length === 0) return undefined;
  let latest = rows[0]!;
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i]!.version ?? 0) > (latest.version ?? 0)) {
      latest = rows[i]!;
    }
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Action definition
// ---------------------------------------------------------------------------

export default defineAction({
  description:
    "List review checkboxes for an artifact. " +
    "EXACT mode (artifactId): return reviews for a specific artifact version. " +
    "LATEST-BY-DOCKEY mode (sprintId + docKey): resolve the latest artifact " +
    "version then return its reviews. New versions start with zero reviews " +
    "(reset semantics).",
  schema: z.object({
    artifactId: z
      .string()
      .optional()
      .describe("Exact artifact id (EXACT mode)"),
    version: z
      .number()
      .int()
      .optional()
      .describe("Artifact version to filter (EXACT mode)"),
    sprintId: z
      .string()
      .optional()
      .describe("Sprint id (LATEST-BY-DOCKEY mode)"),
    docKey: z
      .string()
      .optional()
      .describe("Document key (LATEST-BY-DOCKEY mode)"),
  }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

    const db = getDb();

    // Determine query mode
    const hasArtifactId = !!args.artifactId;
    const hasSprintId = !!args.sprintId;
    const hasDocKey = !!args.docKey;

    let resolvedArtifactId: string | null = null;
    let resolvedVersion: number | null = null;

    if (hasArtifactId) {
      // EXACT mode
      resolvedArtifactId = args.artifactId;
      resolvedVersion = args.version ?? null;
    } else if (hasSprintId && hasDocKey) {
      // LATEST-BY-DOCKEY mode
      const latestArtifact = (
        await db
          .select({
            id: schema.sprintArtifacts.id,
            version: schema.sprintArtifacts.version,
          })
          .from(schema.sprintArtifacts)
          .where(
            and(
              eq(schema.sprintArtifacts.sprintId, args.sprintId!),
              eq(schema.sprintArtifacts.docKey, args.docKey!),
              ownerScope(schema.sprintArtifacts),
            ),
          )
          .orderBy(desc(schema.sprintArtifacts.version))
          .limit(1)
      )[0];

      if (latestArtifact) {
        resolvedArtifactId = latestArtifact.id;
        resolvedVersion = latestArtifact.version;
      }
      // If no artifact found, resolved stays null and we return empty reviews.
    } else {
      throw new Error(
        "Must provide either artifactId (EXACT mode) or both sprintId and docKey (LATEST-BY-DOCKEY mode)",
      );
    }

    // If no artifact was resolved, return empty result
    if (!resolvedArtifactId) {
      return {
        artifactId: null,
        version: null,
        reviews: [],
      };
    }

    // Query review rows
    const whereClauses = [
      eq(schema.artifactReviews.artifactId, resolvedArtifactId),
      ownerScope(schema.artifactReviews),
    ];
    if (resolvedVersion != null) {
      whereClauses.push(eq(schema.artifactReviews.version, resolvedVersion));
    }

    const rows = await db
      .select({
        id: schema.artifactReviews.id,
        reviewKey: schema.artifactReviews.reviewKey,
        checked: schema.artifactReviews.checked,
        reviewer: schema.artifactReviews.reviewer,
        createdAt: schema.artifactReviews.createdAt,
        updatedAt: schema.artifactReviews.updatedAt,
      })
      .from(schema.artifactReviews)
      .where(and(...(whereClauses as [any, ...any[]])))
      .orderBy(asc(schema.artifactReviews.reviewKey));

    return {
      artifactId: resolvedArtifactId,
      version: resolvedVersion,
      reviews: rows.map((r) => ({
        id: r.id,
        reviewKey: r.reviewKey,
        checked: r.checked,
        reviewer: r.reviewer,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    };
  },
});
