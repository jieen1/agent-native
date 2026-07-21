import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { createClient, type Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import {
  afterAll,
  afterEach,
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
let changelogDir: string;
let originalCwd: string;

vi.mock("../../server/db/index.js", () => ({
  getDb: () => db,
  schema: trackerSchema,
}));

type AnyAction = { run: (args: any) => Promise<any> };
let releaseSprint: AnyAction;

const OWNER = "owner@example.com";
const ORG_ID = "org-m5";

function asUser(fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: OWNER, orgId: ORG_ID }, fn);
}

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "release-sprint-db-"));
  client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
  db = drizzle(client, { schema: trackerSchema });

  // Redirect process.cwd() so the changelog write lands in a temp dir.
  changelogDir = fs.mkdtempSync(path.join(os.tmpdir(), "release-sprint-cwd-"));
  originalCwd = process.cwd();
  process.chdir(changelogDir);

  await client.executeMultiple(`
    CREATE TABLE tracker_sprints (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      goal TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '规划',
      phase TEXT NOT NULL DEFAULT 'planning',
      executor_thread_id TEXT,
      branch TEXT DEFAULT '',
      start_date TEXT DEFAULT '',
      end_date TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      studio_state TEXT NOT NULL DEFAULT '{}',
      owner_email TEXT NOT NULL,
      org_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
    );
  `);

  const mod = await import("../release-sprint.js");
  releaseSprint = mod.default as unknown as AnyAction;
});

afterAll(() => {
  process.chdir(originalCwd);
  client?.close();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
  if (changelogDir) fs.rmSync(changelogDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.executeMultiple(`DELETE FROM tracker_sprints`);
  // Clean any changelog files written by prior tests.
  const dir = path.join(changelogDir, "changelog");
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function insertSprint(
  id: string,
  status: string,
  name = "Test Sprint",
): Promise<void> {
  const now = new Date().toISOString();
  await db.insert(trackerSchema.sprints).values({
    id,
    projectId: "proj-1",
    name,
    goal: "",
    status,
    phase: "done",
    branch: "",
    startDate: "",
    endDate: "",
    createdAt: now,
    updatedAt: now,
    studioState: "{}",
    ownerEmail: OWNER,
    orgId: ORG_ID,
    visibility: "private",
  } as any);
}

async function fetchSprint(id: string) {
  return (
    await db
      .select()
      .from(trackerSchema.sprints)
      .where(eq(trackerSchema.sprints.id, id))
  )[0];
}

function changelogFiles(): string[] {
  const dir = path.join(changelogDir, "changelog");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}

describe("release-sprint — idempotency guard (M5)", () => {
  it("transitions 已完成 → 已发布 and writes a changelog entry", async () => {
    await insertSprint("sp-1", "已完成", "Sprint Alpha");

    const result = await asUser(() => releaseSprint.run({ sprintId: "sp-1" }));

    expect(result.status).toBe("已发布");
    expect(result.alreadyReleased).toBe(false);
    expect(result.changelogWritten).toBe(true);

    const row = await fetchSprint("sp-1");
    expect(row.status).toBe("已发布");

    const files = changelogFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^.*-sprint-released-sp-1\.md$/);
  });

  it("is a no-op when already 已发布 (no error, no duplicate changelog)", async () => {
    await insertSprint("sp-2", "已发布", "Sprint Beta");

    const result = await asUser(() => releaseSprint.run({ sprintId: "sp-2" }));

    expect(result.alreadyReleased).toBe(true);
    expect(result.changelogWritten).toBe(false);
    expect(result.status).toBe("已发布");

    // Status unchanged, no changelog written.
    const row = await fetchSprint("sp-2");
    expect(row.status).toBe("已发布");
    expect(changelogFiles()).toHaveLength(0);
  });

  it("calling twice on a 已完成 sprint is safe (second call is no-op)", async () => {
    await insertSprint("sp-3", "已完成", "Sprint Gamma");

    const first = await asUser(() => releaseSprint.run({ sprintId: "sp-3" }));
    expect(first.alreadyReleased).toBe(false);
    expect(first.changelogWritten).toBe(true);

    const second = await asUser(() => releaseSprint.run({ sprintId: "sp-3" }));
    expect(second.alreadyReleased).toBe(true);
    expect(second.changelogWritten).toBe(false);

    // Exactly one changelog file — no duplicate.
    expect(changelogFiles()).toHaveLength(1);
  });

  it("rejects releasing a sprint that is not 已完成", async () => {
    await insertSprint("sp-4", "进行中", "Sprint Delta");

    await expect(
      asUser(() => releaseSprint.run({ sprintId: "sp-4" })),
    ).rejects.toThrow(/已完成/);

    const row = await fetchSprint("sp-4");
    expect(row.status).toBe("进行中");
    expect(changelogFiles()).toHaveLength(0);
  });

  it("produces a deterministic changelog filename keyed on sprint id", async () => {
    await insertSprint("sp-5", "已完成", "Sprint Epsilon");

    await asUser(() => releaseSprint.run({ sprintId: "sp-5" }));
    const files1 = changelogFiles();
    expect(files1).toHaveLength(1);
    const name1 = files1[0];

    // Delete and re-release — same filename must be produced.
    fs.rmSync(path.join(changelogDir, "changelog", name1));
    // Reset status to 已完成 to allow re-release.
    await db
      .update(trackerSchema.sprints)
      .set({ status: "已完成" })
      .where(eq(trackerSchema.sprints.id, "sp-5"));

    await asUser(() => releaseSprint.run({ sprintId: "sp-5" }));
    const files2 = changelogFiles();
    expect(files2).toHaveLength(1);
    expect(files2[0]).toBe(name1);
  });

  it("throws when the sprint is not found or not accessible", async () => {
    await expect(
      asUser(() => releaseSprint.run({ sprintId: "nonexistent" })),
    ).rejects.toThrow(/not found/i);
  });
});
