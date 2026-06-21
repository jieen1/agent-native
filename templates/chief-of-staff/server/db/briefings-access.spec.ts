import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import {
  accessFilter,
  assertAccess,
  ForbiddenError,
  resolveAccess,
  registerShareableResource,
} from "@agent-native/core/sharing";
import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { briefings, briefingShares } from "./schema.js";

// Real in-memory libsql engine (a chief-of-staff dependency) so the test proves
// accessFilter / assertAccess actually isolate one owner's briefings from
// another's — not just that the action calls the sharing helpers.

const ownerA = "a@example.com";
const ownerB = "b@example.com";

let client: Client;
let db: ReturnType<typeof drizzle>;

async function insertBriefing(values: {
  id: string;
  ownerEmail: string;
  briefingDate?: string;
  visibility?: "private" | "org" | "public";
}) {
  await db.insert(briefings).values({
    id: values.id,
    briefingDate: values.briefingDate ?? "2026-06-20",
    kind: "morning",
    title: values.id,
    summaryMd: "",
    sourcesJson: "[]",
    status: "complete",
    focus: null,
    createdAt: "2026-06-20T08:00:00.000Z",
    updatedAt: "2026-06-20T08:00:00.000Z",
    ownerEmail: values.ownerEmail,
    orgId: null,
    visibility: values.visibility ?? "private",
  });
}

async function listVisible(ctx: { userEmail?: string }): Promise<string[]> {
  return runWithRequestContext(ctx, async () => {
    const rows = await db
      .select({ id: briefings.id })
      .from(briefings)
      .where(accessFilter(briefings, briefingShares));
    return rows.map((r) => r.id).sort();
  });
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  db = drizzle(client);
  await client.executeMultiple(`
    CREATE TABLE briefings (
      id TEXT PRIMARY KEY,
      briefing_date TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'adhoc',
      title TEXT NOT NULL,
      summary_md TEXT NOT NULL DEFAULT '',
      sources_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'compiling',
      focus TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      owner_email TEXT NOT NULL DEFAULT 'local@localhost',
      org_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
    );
    CREATE TABLE briefing_shares (
      id TEXT PRIMARY KEY,
      resource_id TEXT NOT NULL,
      principal_type TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  registerShareableResource({
    type: "briefing",
    resourceTable: briefings,
    sharesTable: briefingShares,
    displayName: "Briefing",
    titleColumn: "title",
    getDb: () => db,
  });
});

afterEach(() => {
  client.close();
});

describe("briefings access isolation", () => {
  it("accessFilter list scopes briefings to their owner", async () => {
    await insertBriefing({ id: "a1", ownerEmail: ownerA });
    await insertBriefing({ id: "a2", ownerEmail: ownerA });
    await insertBriefing({ id: "b1", ownerEmail: ownerB });

    expect(await listVisible({ userEmail: ownerA })).toEqual(["a1", "a2"]);
    expect(await listVisible({ userEmail: ownerB })).toEqual(["b1"]);
  });

  it("private briefings are not visible cross-user even when public-looking date matches", async () => {
    await insertBriefing({ id: "a1", ownerEmail: ownerA });
    const visibleToB = await listVisible({ userEmail: ownerB });
    expect(visibleToB).not.toContain("a1");
  });

  it("a viewer-shared briefing becomes visible to the grantee", async () => {
    await insertBriefing({ id: "a1", ownerEmail: ownerA });
    await db.insert(briefingShares).values({
      id: "share_1",
      resourceId: "a1",
      principalType: "user",
      principalId: ownerB,
      role: "viewer",
      createdBy: ownerA,
      createdAt: "2026-06-20T08:00:00.000Z",
    });

    expect(await listVisible({ userEmail: ownerB })).toContain("a1");
  });

  it("resolveAccess returns owner role for the owner and null for an outsider", async () => {
    await insertBriefing({ id: "a1", ownerEmail: ownerA });

    const asOwner = await runWithRequestContext({ userEmail: ownerA }, () =>
      resolveAccess("briefing", "a1"),
    );
    expect(asOwner?.role).toBe("owner");

    const asOutsider = await runWithRequestContext({ userEmail: ownerB }, () =>
      resolveAccess("briefing", "a1"),
    );
    expect(asOutsider).toBeNull();
  });

  it("assertAccess editor throws ForbiddenError for a non-owner", async () => {
    await insertBriefing({ id: "a1", ownerEmail: ownerA });

    await expect(
      runWithRequestContext({ userEmail: ownerB }, () =>
        assertAccess("briefing", "a1", "editor"),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const owner = await runWithRequestContext({ userEmail: ownerA }, () =>
      assertAccess("briefing", "a1", "editor"),
    );
    expect(owner.role).toBe("owner");
  });
});
