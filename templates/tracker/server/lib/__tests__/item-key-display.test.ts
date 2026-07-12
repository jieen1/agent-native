import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import * as trackerSchema from "../../db/schema.js";
import {
  computeItemKeyDisplay,
  computeItemKeyDisplays,
} from "../item-key-display.js";

// ============================================================================
// T-F8-05: itemKey 消歧(读路径) — historical duplicate itemKeys (SDLC-032~036)
// get a short id suffix appended ONLY when they collide with a sibling in
// the SAME project; unique keys and blank keys pass through unchanged.
// Detection is against the full project population, not just the batch
// passed in (a status-filtered list must still catch a duplicate whose
// sibling was filtered out).
//
// The sibling-lookup query is ownerScope()'d (a required scope check for any
// ownableColumns() table), so every call below runs inside
// runWithRequestContext with a fixed owner, and every inserted row carries
// that same owner_email.
// ============================================================================

const OWNER = "owner@example.com";
const ORG_ID = "org-f8";

function asUser<T>(fn: () => Promise<T> | T): Promise<T> {
  return runWithRequestContext({ userEmail: OWNER, orgId: ORG_ID }, fn);
}

let client: Client;
let db: LibSQLDatabase<typeof trackerSchema>;
let dbDir: string;

beforeEach(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "item-key-display-"));
  client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
  db = drizzle(client, { schema: trackerSchema });
  await client.executeMultiple(`
    CREATE TABLE tracker_work_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      item_key TEXT NOT NULL DEFAULT '',
      owner_email TEXT NOT NULL,
      org_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
    );
  `);
});

afterAll(() => {
  client?.close();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

async function insert(id: string, projectId: string, itemKey: string) {
  await client.execute({
    sql: `INSERT INTO tracker_work_items (id, project_id, item_key, owner_email, org_id) VALUES (?, ?, ?, ?, ?)`,
    args: [id, projectId, itemKey, OWNER, ORG_ID],
  });
}

describe("computeItemKeyDisplays", () => {
  it("T-F8-05: a real duplicate pair (two items, same project, same itemKey) gets distinct suffixed displays", async () => {
    await insert("wi-a", "proj-1", "SDLC-033");
    await insert("wi-b", "proj-1", "SDLC-033");

    const displays = await asUser(() =>
      computeItemKeyDisplays(db as any, [
        { id: "wi-a", projectId: "proj-1", itemKey: "SDLC-033" },
        { id: "wi-b", projectId: "proj-1", itemKey: "SDLC-033" },
      ]),
    );

    const a = displays.get("wi-a")!;
    const b = displays.get("wi-b")!;
    expect(a).not.toBe(b);
    // Suffix is id.slice(0,4) verbatim — any 4 characters, not restricted to
    // a nanoid-style alphabet (test ids here are short literal strings).
    expect(a).toMatch(/^SDLC-033·.{4}$/);
    expect(b).toMatch(/^SDLC-033·.{4}$/);
  });

  it("a non-duplicate item in the same project is returned unchanged (no suffix)", async () => {
    await insert("wi-a", "proj-1", "SDLC-033");
    await insert("wi-b", "proj-1", "SDLC-033");
    await insert("wi-c", "proj-1", "SDLC-040");

    const displays = await asUser(() =>
      computeItemKeyDisplays(db as any, [
        { id: "wi-c", projectId: "proj-1", itemKey: "SDLC-040" },
      ]),
    );
    expect(displays.get("wi-c")).toBe("SDLC-040");
  });

  it("detects the duplicate even when the FETCHED BATCH only contains one of the two siblings (status-filtered list case)", async () => {
    await insert("wi-a", "proj-1", "SDLC-033"); // e.g. status=open
    await insert("wi-b", "proj-1", "SDLC-033"); // e.g. status=closed, filtered out of the batch

    // Simulate list-work-items filtering to status=open: only wi-a is in the
    // batch passed in, but wi-b still exists in the project — must still flag.
    const displays = await asUser(() =>
      computeItemKeyDisplays(db as any, [
        { id: "wi-a", projectId: "proj-1", itemKey: "SDLC-033" },
      ]),
    );
    expect(displays.get("wi-a")).toMatch(/^SDLC-033·/);
  });

  it("the SAME itemKey in DIFFERENT projects is not a collision", async () => {
    await insert("wi-a", "proj-1", "X-001");
    await insert("wi-b", "proj-2", "X-001");

    const displays = await asUser(() =>
      computeItemKeyDisplays(db as any, [
        { id: "wi-a", projectId: "proj-1", itemKey: "X-001" },
        { id: "wi-b", projectId: "proj-2", itemKey: "X-001" },
      ]),
    );
    expect(displays.get("wi-a")).toBe("X-001");
    expect(displays.get("wi-b")).toBe("X-001");
  });

  it("blank/null itemKeys are never suffixed", async () => {
    const displays = await asUser(() =>
      computeItemKeyDisplays(db as any, [
        { id: "wi-a", projectId: "proj-1", itemKey: "" },
        { id: "wi-b", projectId: "proj-1", itemKey: null },
      ]),
    );
    expect(displays.get("wi-a")).toBe("");
    expect(displays.get("wi-b")).toBe("");
  });

  it("an empty rows array returns an empty map without querying", async () => {
    const displays = await asUser(() => computeItemKeyDisplays(db as any, []));
    expect(displays.size).toBe(0);
  });

  it("ownerScope: a duplicate belonging to a DIFFERENT owner is not counted as a collision", async () => {
    await insert("wi-a", "proj-1", "SDLC-033");
    // Same project+itemKey, but a different tenant entirely.
    await client.execute({
      sql: `INSERT INTO tracker_work_items (id, project_id, item_key, owner_email, org_id) VALUES (?, ?, ?, ?, ?)`,
      args: ["wi-other-tenant", "proj-1", "SDLC-033", "someone-else@example.com", "org-other"],
    });

    const displays = await asUser(() =>
      computeItemKeyDisplays(db as any, [
        { id: "wi-a", projectId: "proj-1", itemKey: "SDLC-033" },
      ]),
    );
    // Only one row visible to THIS caller for (proj-1, SDLC-033) -> no suffix.
    expect(displays.get("wi-a")).toBe("SDLC-033");
  });
});

describe("computeItemKeyDisplay (single-row convenience)", () => {
  it("resolves one row's display without the caller building an array", async () => {
    await insert("wi-a", "proj-1", "SDLC-033");
    await insert("wi-b", "proj-1", "SDLC-033");
    const display = await asUser(() =>
      computeItemKeyDisplay(db as any, {
        id: "wi-a",
        projectId: "proj-1",
        itemKey: "SDLC-033",
      }),
    );
    expect(display).toMatch(/^SDLC-033·/);
  });
});
