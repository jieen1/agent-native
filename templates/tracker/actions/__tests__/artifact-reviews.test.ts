import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { createClient, type Client } from "@libsql/client";
import { eq, and } from "drizzle-orm";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as trackerSchema from "../../server/db/schema.js";

let client: Client;
let db: LibSQLDatabase<typeof trackerSchema>;
let dbDir: string;

vi.mock("../../server/db/index.js", () => ({
  getDb: () => db,
  schema: trackerSchema,
}));

type AnyAction = { run: (args: any) => Promise<any> };
let setArtifactReview: AnyAction;
let listArtifactReviews: AnyAction;
let buildArtifactReviewUpsertValues: (typeof import("../set-artifact-review.js"))["buildArtifactReviewUpsertValues"];
let pickLatestArtifactVersion: (typeof import("../list-artifact-reviews.js"))["pickLatestArtifactVersion"];

const OWNER = "owner@example.com";
const ORG_ID = "org-123";

function asUser(
  ctx: { userEmail?: string; userName?: string; orgId?: string },
  fn: () => Promise<any> | any,
) {
  return runWithRequestContext(ctx, fn);
}

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-reviews-"));
  client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
  db = drizzle(client, { schema: trackerSchema });

  await client.executeMultiple(`
    CREATE TABLE tracker_sprint_artifacts (
      id TEXT PRIMARY KEY,
      sprint_id TEXT NOT NULL,
      doc_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      supersedes TEXT,
      produced_by_kind TEXT NOT NULL DEFAULT 'agent',
      content TEXT NOT NULL DEFAULT '',
      content_ref TEXT,
      created_at TEXT NOT NULL,
      owner_email TEXT NOT NULL,
      org_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
    );
    CREATE TABLE tracker_artifact_reviews (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      review_key TEXT NOT NULL,
      checked INTEGER NOT NULL DEFAULT 0,
      reviewer TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      owner_email TEXT NOT NULL,
      org_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
    );
  `);

  const setModule = await import("../set-artifact-review.js");
  const listModule = await import("../list-artifact-reviews.js");
  setArtifactReview = setModule.default as unknown as AnyAction;
  listArtifactReviews = listModule.default as unknown as AnyAction;
  buildArtifactReviewUpsertValues = setModule.buildArtifactReviewUpsertValues;
  pickLatestArtifactVersion = listModule.pickLatestArtifactVersion;
}, 30_000);

afterAll(() => {
  client?.close();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.executeMultiple(`
    DELETE FROM tracker_artifact_reviews;
    DELETE FROM tracker_sprint_artifacts;
  `);
});

// ============================================================================
// Pure-function tests (no DB)
// ============================================================================

describe("pickLatestArtifactVersion (pure)", () => {
  it("returns undefined for empty array", () => {
    expect(pickLatestArtifactVersion([])).toBeUndefined();
  });

  it("returns the single element", () => {
    const rows = [{ id: "a1", version: 1 }];
    expect(pickLatestArtifactVersion(rows)).toEqual({ id: "a1", version: 1 });
  });

  it("returns the element with the highest version", () => {
    const rows = [
      { id: "a1", version: 1 },
      { id: "a3", version: 3 },
      { id: "a2", version: 2 },
    ];
    expect(pickLatestArtifactVersion(rows)).toEqual({ id: "a3", version: 3 });
  });

  it("returns the first element if tied", () => {
    const rows = [
      { id: "a1", version: 2 },
      { id: "a2", version: 2 },
    ];
    expect(pickLatestArtifactVersion(rows)).toEqual({ id: "a1", version: 2 });
  });
});

describe("buildArtifactReviewUpsertValues (pure)", () => {
  it("returns insert payload when no existing row", () => {
    const result = buildArtifactReviewUpsertValues(
      undefined,
      { artifactId: "a1", version: 1, reviewKey: "k1", checked: true },
      "user@x.com",
      "2025-01-01T00:00:00Z",
    );
    expect(result.kind).toBe("insert");
    expect((result as any).values.checked).toBe(1);
    expect((result as any).values.reviewer).toBe("user@x.com");
    expect((result as any).values.artifactId).toBe("a1");
    expect((result as any).values.version).toBe(1);
  });

  it("returns update payload when existing row provided", () => {
    const result = buildArtifactReviewUpsertValues(
      { id: "existing-id", createdAt: "2025-01-01T00:00:00Z" },
      { artifactId: "a1", version: 1, reviewKey: "k1", checked: false },
      "user@x.com",
      "2025-01-02T00:00:00Z",
    );
    expect(result.kind).toBe("update");
    expect((result as any).id).toBe("existing-id");
    expect((result as any).values.checked).toBe(0);
    expect((result as any).values.reviewer).toBe("user@x.com");
    expect((result as any).values.updatedAt).toBe("2025-01-02T00:00:00Z");
  });

  it("uses provided reviewer instead of ownerEmail", () => {
    const result = buildArtifactReviewUpsertValues(
      undefined,
      {
        artifactId: "a1",
        version: 1,
        reviewKey: "k1",
        checked: true,
        reviewer: "other@x.com",
      },
      "user@x.com",
      "2025-01-01T00:00:00Z",
    );
    expect((result as any).values.reviewer).toBe("other@x.com");
  });
});

// ============================================================================
// Integration tests (DB-backed)
// ============================================================================

describe("set-artifact-review + list-artifact-reviews integration", () => {
  async function insertArtifact(
    id: string,
    sprintId: string,
    docKey: string,
    version: number = 1,
  ) {
    const now = new Date().toISOString();
    await db.insert(trackerSchema.sprintArtifacts).values({
      id,
      sprintId,
      docKey,
      kind: "test-plan",
      name: "Test Plan",
      version,
      supersedes: null,
      producedByKind: "agent",
      content: "",
      contentRef: null,
      createdAt: now,
      ownerEmail: OWNER,
      orgId: ORG_ID,
      visibility: "private",
    });
  }

  it("Scenario 1: Insert 3 reviews for v1, list via LATEST-BY-DOCKEY returns all 3", async () => {
    const sprintId = "sprint-1";
    const docKey = "test-plan";
    const artifactId = "art-v1";

    await insertArtifact(artifactId, sprintId, docKey, 1);

    const reviews = [
      { reviewKey: "scenario:S1:falsifiable" },
      { reviewKey: "scenario:S1:prereq-real" },
      { reviewKey: "scenario:S1:tool-executable" },
    ];

    for (const r of reviews) {
      await asUser({ userEmail: OWNER, orgId: ORG_ID }, () =>
        setArtifactReview.run({
          artifactId,
          version: 1,
          reviewKey: r.reviewKey,
          checked: true,
        }),
      );
    }

    const result = await asUser({ userEmail: OWNER, orgId: ORG_ID }, () =>
      listArtifactReviews.run({ sprintId, docKey }),
    );

    expect(result.artifactId).toBe(artifactId);
    expect(result.version).toBe(1);
    expect(result.reviews).toHaveLength(3);
    const keys = result.reviews.map((r: any) => r.reviewKey).sort();
    expect(keys).toEqual([
      "scenario:S1:falsifiable",
      "scenario:S1:prereq-real",
      "scenario:S1:tool-executable",
    ]);
  });

  it("Scenario 2: After creating v2 artifact, LATEST-BY-DOCKEY returns 0 reviews (reset semantics)", async () => {
    const sprintId = "sprint-2";
    const docKey = "test-plan";
    const artifactIdV1 = "art-v1";
    const artifactIdV2 = "art-v2";

    // Create v1 and add 3 reviews
    await insertArtifact(artifactIdV1, sprintId, docKey, 1);
    for (const key of [
      "scenario:S1:falsifiable",
      "scenario:S1:prereq-real",
      "scenario:S1:tool-executable",
    ]) {
      await asUser({ userEmail: OWNER, orgId: ORG_ID }, () =>
        setArtifactReview.run({
          artifactId: artifactIdV1,
          version: 1,
          reviewKey: key,
          checked: true,
        }),
      );
    }

    // Now create v2 (simulating "build v2")
    await insertArtifact(artifactIdV2, sprintId, docKey, 2);

    // Query via LATEST-BY-DOCKEY — should resolve to v2 and return 0 reviews
    const result = await asUser({ userEmail: OWNER, orgId: ORG_ID }, () =>
      listArtifactReviews.run({ sprintId, docKey }),
    );

    expect(result.artifactId).toBe(artifactIdV2);
    expect(result.version).toBe(2);
    expect(result.reviews).toHaveLength(0);
  });

  it("Scenario 3: EXACT mode still returns v1 reviews after v2 exists (audit trail)", async () => {
    const sprintId = "sprint-3";
    const docKey = "test-plan";
    const artifactIdV1 = "art-v1";
    const artifactIdV2 = "art-v2";

    // Create v1 with 3 reviews
    await insertArtifact(artifactIdV1, sprintId, docKey, 1);
    for (const key of [
      "scenario:S1:falsifiable",
      "scenario:S1:prereq-real",
      "scenario:S1:tool-executable",
    ]) {
      await asUser({ userEmail: OWNER, orgId: ORG_ID }, () =>
        setArtifactReview.run({
          artifactId: artifactIdV1,
          version: 1,
          reviewKey: key,
          checked: true,
        }),
      );
    }

    // Create v2
    await insertArtifact(artifactIdV2, sprintId, docKey, 2);

    // EXACT mode for v1 — should still return 3 reviews
    const result = await asUser({ userEmail: OWNER, orgId: ORG_ID }, () =>
      listArtifactReviews.run({ artifactId: artifactIdV1, version: 1 }),
    );

    expect(result.artifactId).toBe(artifactIdV1);
    expect(result.version).toBe(1);
    expect(result.reviews).toHaveLength(3);
  });

  it("Scenario 4: Idempotency — toggling checked updates one row, no duplicate", async () => {
    const sprintId = "sprint-4";
    const docKey = "test-plan";
    const artifactId = "art-v1";

    await insertArtifact(artifactId, sprintId, docKey, 1);

    const reviewKey = "scenario:S1:falsifiable";

    // First call: set checked=true
    await asUser({ userEmail: OWNER, orgId: ORG_ID }, () =>
      setArtifactReview.run({
        artifactId,
        version: 1,
        reviewKey,
        checked: true,
      }),
    );

    // Second call: set checked=false, different reviewer
    const result2 = await asUser({ userEmail: OWNER, orgId: ORG_ID }, () =>
      setArtifactReview.run({
        artifactId,
        version: 1,
        reviewKey,
        checked: false,
        reviewer: "other@x.com",
      }),
    );

    // Verify exactly ONE row exists
    const rows = await db
      .select()
      .from(trackerSchema.artifactReviews)
      .where(
        and(
          eq(trackerSchema.artifactReviews.artifactId, artifactId),
          eq(trackerSchema.artifactReviews.version, 1),
          eq(trackerSchema.artifactReviews.reviewKey, reviewKey),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.checked).toBe(0);
    expect(rows[0]!.reviewer).toBe("other@x.com");

    // The returned row reflects the latest values
    expect(result2.checked).toBe(0);
    expect(result2.reviewer).toBe("other@x.com");

    // The same id was returned (not a new id)
    expect(result2.id).toBe(rows[0]!.id);
  });

  it("Scenario 5: Validation error when neither mode's args present", async () => {
    await expect(
      asUser({ userEmail: OWNER, orgId: ORG_ID }, () =>
        listArtifactReviews.run({}),
      ),
    ).rejects.toThrow(
      /Must provide either artifactId.*or both sprintId and docKey/,
    );
  });

  it("LATEST-BY-DOCKEY returns empty reviews when no artifact exists", async () => {
    const result = await asUser({ userEmail: OWNER, orgId: ORG_ID }, () =>
      listArtifactReviews.run({ sprintId: "nonexistent", docKey: "test-plan" }),
    );

    expect(result.artifactId).toBeNull();
    expect(result.version).toBeNull();
    expect(result.reviews).toEqual([]);
  });

  it("EXACT mode with version filter returns only that version's reviews", async () => {
    const sprintId = "sprint-5";
    const docKey = "test-plan";
    const artifactIdV1 = "art-v1";

    await insertArtifact(artifactIdV1, sprintId, docKey, 1);

    // Add review for v1
    await asUser({ userEmail: OWNER, orgId: ORG_ID }, () =>
      setArtifactReview.run({
        artifactId: artifactIdV1,
        version: 1,
        reviewKey: "scenario:S1:falsifiable",
        checked: true,
      }),
    );

    const result = await asUser({ userEmail: OWNER, orgId: ORG_ID }, () =>
      listArtifactReviews.run({ artifactId: artifactIdV1, version: 1 }),
    );

    expect(result.reviews).toHaveLength(1);
    expect(result.reviews[0]!.checked).toBe(1);
  });
});
