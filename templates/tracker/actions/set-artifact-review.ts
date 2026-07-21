import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

// ---------------------------------------------------------------------------
// Pure helpers — testable without any DB / HTTP context.
// ---------------------------------------------------------------------------

export interface ArtifactReviewRow {
  id: string;
  artifactId: string;
  version: number;
  reviewKey: string;
  checked: number;
  reviewer: string;
  createdAt: string;
  updatedAt: string;
}

interface SetArtifactReviewArgs {
  artifactId: string;
  version: number;
  reviewKey: string;
  checked: boolean;
  reviewer?: string;
}

type ArtifactReviewInsertValues = typeof schema.artifactReviews.$inferInsert;

/**
 * Build the field values for an upsert of an artifact review row.
 * Returns either an INSERT payload (with fresh id/timestamps) or
 * an UPDATE payload (preserving existing id/createdAt).
 */
export function buildArtifactReviewUpsertValues(
  existing: Pick<ArtifactReviewRow, "id" | "createdAt"> | undefined,
  args: SetArtifactReviewArgs,
  ownerEmail: string,
  now: string,
):
  | { kind: "insert"; values: ArtifactReviewInsertValues }
  | {
      kind: "update";
      id: string;
      values: Partial<ArtifactReviewInsertValues>;
    } {
  const checkedInt = args.checked ? 1 : 0;
  const reviewer = args.reviewer ?? ownerEmail;

  if (existing) {
    return {
      kind: "update",
      id: existing.id,
      values: {
        checked: checkedInt,
        reviewer,
        updatedAt: now,
      },
    };
  }

  return {
    kind: "insert",
    values: {
      id: nanoid(),
      artifactId: args.artifactId,
      version: args.version,
      reviewKey: args.reviewKey,
      checked: checkedInt,
      reviewer,
      createdAt: now,
      updatedAt: now,
      ownerEmail,
      orgId: getRequestOrgId() ?? null,
      visibility: "private",
    },
  };
}

// ---------------------------------------------------------------------------
// Action definition
// ---------------------------------------------------------------------------

export default defineAction({
  description:
    "Set (upsert) a single v2.1 review checkbox for an artifact version. " +
    "Idempotent: calling twice with the same (artifactId, version, reviewKey) " +
    "updates the existing row instead of inserting a duplicate.",
  schema: z.object({
    artifactId: z.string().min(1).describe("Sprint artifact id"),
    version: z.number().int().min(1).describe("Artifact version"),
    reviewKey: z
      .string()
      .min(1)
      .describe('Review question key, e.g. "scenario:S1:falsifiable"'),
    checked: z
      .boolean()
      .default(true)
      .describe("Whether the checkbox is checked"),
    reviewer: z
      .string()
      .optional()
      .describe("Email of the reviewer; defaults to the authenticated user"),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId() ?? null;

    const db = getDb();
    const now = new Date().toISOString();

    // Look up existing row scoped to current owner
    const existing = (
      await db
        .select({
          id: schema.artifactReviews.id,
          createdAt: schema.artifactReviews.createdAt,
        })
        .from(schema.artifactReviews)
        .where(
          and(
            eq(schema.artifactReviews.artifactId, args.artifactId),
            eq(schema.artifactReviews.version, args.version),
            eq(schema.artifactReviews.reviewKey, args.reviewKey),
            ownerScope(schema.artifactReviews),
          ),
        )
        .limit(1)
    )[0];

    const upsert = buildArtifactReviewUpsertValues(
      existing,
      {
        artifactId: args.artifactId,
        version: args.version,
        reviewKey: args.reviewKey,
        checked: args.checked,
        reviewer: args.reviewer,
      },
      ownerEmail,
      now,
    );

    if (upsert.kind === "update") {
      await db
        .update(schema.artifactReviews)
        .set(upsert.values)
        .where(eq(schema.artifactReviews.id, upsert.id));

      return {
        id: upsert.id,
        artifactId: args.artifactId,
        version: args.version,
        reviewKey: args.reviewKey,
        checked: args.checked ? 1 : 0,
        reviewer: args.reviewer ?? ownerEmail,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
    }

    // Insert
    const inserted = await db
      .insert(schema.artifactReviews)
      .values(upsert.values)
      .returning();

    const row = inserted[0]!;
    return {
      id: row.id,
      artifactId: row.artifactId,
      version: row.version,
      reviewKey: row.reviewKey,
      checked: row.checked,
      reviewer: row.reviewer,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  },
});
