/**
 * Phase B1 integration tests for the briefing action surface.
 *
 * These exercise the REAL `list-briefings`, `get-briefing`, and
 * `update-briefing` actions end-to-end against a real in-memory libsql engine,
 * with the REAL `@agent-native/core/sharing` helpers (accessFilter /
 * resolveAccess / assertAccess) — nothing in the access path is mocked. Only
 * the DB handle is swapped for an in-memory one (the actions read it from
 * `../server/db/index.js`, which we mock to point at the same registered db).
 *
 * Coverage (docs/IMPLEMENTATION_PLAN.md Phase B1 acceptance):
 *   - Cross-user access isolation THROUGH the actions: user B's list-briefings
 *     and get-briefing never reveal user A's private briefing.
 *   - list / get / update round-trip: insert -> list lists it -> get fetches it
 *     -> update changes summaryMd/title -> get reflects the new values.
 *   - Empty state: with no briefings, list-briefings returns [] and does not
 *     throw.
 *   - update auto-refresh chain: a fresh list/get returns the updated value
 *     after update. (The UI's automatic refetch is guaranteed separately by
 *     useDbSync + the mutating-action change event — see refresh-contract.spec.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { registerShareableResource } from "@agent-native/core/sharing";
import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { briefings, briefingShares } from "../server/db/schema.js";

const ownerA = "a@example.com";
const ownerB = "b@example.com";

let client: Client;
let db: ReturnType<typeof drizzle>;

// The actions import `{ getDb, schema }` from ../server/db/index.js. We mock
// that module so the real action code runs against our in-memory db + the real
// schema, instead of opening the template's on-disk SQLite file. We do NOT mock
// @agent-native/core/sharing, so access control is genuinely exercised.
vi.mock("../server/db/index.js", async () => ({
  getDb: () => db,
  schema: await vi.importActual("../server/db/schema.js"),
}));

// Import the real actions after the mock is registered.
const { default: listBriefings } = await import("./list-briefings.js");
const { default: getBriefing } = await import("./get-briefing.js");
const { default: updateBriefing } = await import("./update-briefing.js");

async function insertBriefing(values: {
  id: string;
  ownerEmail: string;
  title?: string;
  summaryMd?: string;
  briefingDate?: string;
  status?: "compiling" | "complete" | "partial" | "failed";
  sourcesJson?: string;
  visibility?: "private" | "org" | "public";
}) {
  await db.insert(briefings).values({
    id: values.id,
    briefingDate: values.briefingDate ?? "2026-06-20",
    kind: "morning",
    title: values.title ?? values.id,
    summaryMd: values.summaryMd ?? "",
    sourcesJson: values.sourcesJson ?? "[]",
    status: values.status ?? "complete",
    focus: null,
    createdAt: "2026-06-20T08:00:00.000Z",
    updatedAt: "2026-06-20T08:00:00.000Z",
    ownerEmail: values.ownerEmail,
    orgId: null,
    visibility: values.visibility ?? "private",
  });
}

function asUser<T>(userEmail: string, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ userEmail }, fn);
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
  // Register against THIS in-memory db so resolveAccess/assertAccess read it.
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

describe("Phase B1 — empty state", () => {
  it("list-briefings returns [] and does not throw when there are no briefings", async () => {
    const rows = await asUser(ownerA, () => listBriefings.run({}));
    expect(rows).toEqual([]);
  });

  it("list-briefings with a date filter returns [] on an empty table", async () => {
    const rows = await asUser(ownerA, () =>
      listBriefings.run({ date: "2026-06-20" }),
    );
    expect(rows).toEqual([]);
  });
});

describe("Phase B1 — list / get / update round-trip", () => {
  it("insert -> list lists it -> get fetches it", async () => {
    await insertBriefing({
      id: "brief_1",
      ownerEmail: ownerA,
      title: "Monday brief",
      summaryMd: "original summary",
    });

    const listed = await asUser(ownerA, () => listBriefings.run({}));
    expect(listed.map((r) => r.id)).toEqual(["brief_1"]);
    expect(listed[0]).toMatchObject({
      id: "brief_1",
      title: "Monday brief",
      summaryMd: "original summary",
      ownerEmail: ownerA,
    });

    const fetched = await asUser(ownerA, () =>
      getBriefing.run({ id: "brief_1" }),
    );
    expect(fetched).toMatchObject({
      id: "brief_1",
      title: "Monday brief",
      summaryMd: "original summary",
      role: "owner",
    });
    // sources_json is parsed into a structured array on get.
    expect(Array.isArray(fetched.sources)).toBe(true);
  });

  it("update changes summaryMd and title; a fresh get reflects the new values", async () => {
    await insertBriefing({
      id: "brief_1",
      ownerEmail: ownerA,
      title: "old title",
      summaryMd: "old summary",
    });

    const updated = await asUser(ownerA, () =>
      updateBriefing.run({
        id: "brief_1",
        summaryMd: "POLISHED-MARKER new narrative",
        title: "new title",
      }),
    );
    expect(updated).toMatchObject({
      id: "brief_1",
      title: "new title",
      summaryMd: "POLISHED-MARKER new narrative",
    });

    // The round-trip: a brand-new get sees the persisted change.
    const refetched = await asUser(ownerA, () =>
      getBriefing.run({ id: "brief_1" }),
    );
    expect(refetched.summaryMd).toBe("POLISHED-MARKER new narrative");
    expect(refetched.title).toBe("new title");

    // And list reflects the new title/summary too (this is exactly what the
    // panel's useActionQuery("list-briefings") re-reads after the action's
    // change event fires — UI refetch itself is guaranteed by useDbSync).
    const relisted = await asUser(ownerA, () => listBriefings.run({}));
    expect(relisted[0]).toMatchObject({
      title: "new title",
      summaryMd: "POLISHED-MARKER new narrative",
    });
  });

  it("update bumps updatedAt to a new ISO timestamp", async () => {
    await insertBriefing({ id: "brief_1", ownerEmail: ownerA });

    const before = (
      await asUser(ownerA, () => getBriefing.run({ id: "brief_1" }))
    ).updatedAt;
    const updated = await asUser(ownerA, () =>
      updateBriefing.run({ id: "brief_1", title: "renamed" }),
    );
    expect(typeof updated.updatedAt).toBe("string");
    expect(updated.updatedAt).not.toBe(before);
    expect(() => new Date(updated.updatedAt).toISOString()).not.toThrow();
  });

  it("update with neither summaryMd nor title rejects", async () => {
    await insertBriefing({ id: "brief_1", ownerEmail: ownerA });
    await expect(
      asUser(ownerA, () => updateBriefing.run({ id: "brief_1" })),
    ).rejects.toThrow(/at least one of summaryMd or title/i);
  });
});

describe("Phase B1 — cross-user access isolation through the actions", () => {
  it("list-briefings never returns another user's private briefing", async () => {
    await insertBriefing({ id: "a1", ownerEmail: ownerA });
    await insertBriefing({ id: "a2", ownerEmail: ownerA });
    await insertBriefing({ id: "b1", ownerEmail: ownerB });

    const bSees = await asUser(ownerB, () => listBriefings.run({}));
    expect(bSees.map((r) => r.id)).toEqual(["b1"]);
    expect(bSees.map((r) => r.id)).not.toContain("a1");
    expect(bSees.map((r) => r.id)).not.toContain("a2");

    const aSees = await asUser(ownerA, () => listBriefings.run({}));
    expect(aSees.map((r) => r.id).sort()).toEqual(["a1", "a2"]);
  });

  it("get-briefing throws (no data leak) when user B opens user A's private briefing", async () => {
    await insertBriefing({ id: "a1", ownerEmail: ownerA, summaryMd: "secret" });

    await expect(
      asUser(ownerB, () => getBriefing.run({ id: "a1" })),
    ).rejects.toThrow();
  });

  it("update-briefing throws for user B against user A's briefing and does not mutate it", async () => {
    await insertBriefing({
      id: "a1",
      ownerEmail: ownerA,
      title: "A title",
      summaryMd: "A summary",
    });

    await expect(
      asUser(ownerB, () =>
        updateBriefing.run({ id: "a1", summaryMd: "hijacked" }),
      ),
    ).rejects.toThrow();

    // Owner still sees the original, unmutated content.
    const owned = await asUser(ownerA, () => getBriefing.run({ id: "a1" }));
    expect(owned.summaryMd).toBe("A summary");
    expect(owned.title).toBe("A title");
  });

  it("a viewer-shared briefing is listable and gettable by the grantee", async () => {
    await insertBriefing({ id: "a1", ownerEmail: ownerA, title: "shared" });
    await db.insert(briefingShares).values({
      id: "share_1",
      resourceId: "a1",
      principalType: "user",
      principalId: ownerB,
      role: "viewer",
      createdBy: ownerA,
      createdAt: "2026-06-20T08:00:00.000Z",
    });

    const listed = await asUser(ownerB, () => listBriefings.run({}));
    expect(listed.map((r) => r.id)).toContain("a1");

    const fetched = await asUser(ownerB, () => getBriefing.run({ id: "a1" }));
    expect(fetched).toMatchObject({ id: "a1", role: "viewer" });
  });

  it("a viewer-shared briefing is NOT updatable by the viewer (editor required)", async () => {
    await insertBriefing({ id: "a1", ownerEmail: ownerA, summaryMd: "A" });
    await db.insert(briefingShares).values({
      id: "share_1",
      resourceId: "a1",
      principalType: "user",
      principalId: ownerB,
      role: "viewer",
      createdBy: ownerA,
      createdAt: "2026-06-20T08:00:00.000Z",
    });

    await expect(
      asUser(ownerB, () => updateBriefing.run({ id: "a1", summaryMd: "x" })),
    ).rejects.toThrow();
  });
});
