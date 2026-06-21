/**
 * Phase C SSR privacy gate (§455 / §462) for `fetchPublicBriefing`.
 *
 * The SSR loader for `/briefings/:id` calls this shallow reader to decide
 * whether to server-render real briefing content. The hard contract: it returns
 * the title + summary body ONLY for a `visibility: "public"` row, and `null`
 * for private/org/missing rows — so a private briefing's title or body never
 * lands in SSR HTML for an unauthenticated fetcher (link-unfurl bots).
 *
 * Runs the REAL reader against an in-memory libsql db; no request context is set
 * (the reader is deliberately session-free, like plan's `fetchPublicPlanMeta`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { briefings } from "../db/schema.js";

let client: Client;
let db: ReturnType<typeof drizzle>;

vi.mock("../db/index.js", async () => ({
  getDb: () => db,
  schema: await vi.importActual("../db/schema.js"),
}));

const { fetchPublicBriefing } = await import("./briefing-meta.server.js");

async function insert(values: {
  id: string;
  visibility: "private" | "org" | "public";
  title?: string;
  summaryMd?: string;
}) {
  await db.insert(briefings).values({
    id: values.id,
    briefingDate: "2026-06-21",
    kind: "morning",
    title: values.title ?? values.id,
    summaryMd: values.summaryMd ?? "",
    sourcesJson: "[]",
    status: "complete",
    focus: null,
    createdAt: "2026-06-21T08:00:00.000Z",
    updatedAt: "2026-06-21T08:00:00.000Z",
    ownerEmail: "owner@example.com",
    orgId: null,
    visibility: values.visibility,
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
  `);
});

afterEach(() => {
  client.close();
});

describe("fetchPublicBriefing", () => {
  it("returns title + summary body for a public briefing (SSR content)", async () => {
    await insert({
      id: "brief_pub",
      visibility: "public",
      title: "Morning briefing — 2026-06-21",
      summaryMd: "## Mail\n\nReply to Dana before noon.",
    });

    const view = await fetchPublicBriefing("brief_pub");
    expect(view).not.toBeNull();
    expect(view?.title).toBe("Morning briefing — 2026-06-21");
    expect(view?.summaryMd).toContain("Reply to Dana before noon.");
    expect(view?.briefingDate).toBe("2026-06-21");
    expect(view?.kind).toBe("morning");
  });

  it("returns null for a private briefing (never SSR a private title/body)", async () => {
    await insert({
      id: "brief_priv",
      visibility: "private",
      title: "Secret briefing",
      summaryMd: "confidential",
    });
    expect(await fetchPublicBriefing("brief_priv")).toBeNull();
  });

  it("returns null for an org-visibility briefing (only public is anon-SSR'd)", async () => {
    await insert({ id: "brief_org", visibility: "org" });
    expect(await fetchPublicBriefing("brief_org")).toBeNull();
  });

  it("returns null for a missing briefing", async () => {
    expect(await fetchPublicBriefing("brief_nope")).toBeNull();
  });
});
