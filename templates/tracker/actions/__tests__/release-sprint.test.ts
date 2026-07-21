import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { createClient, type Client } from "@libsql/client";
import { eq } from "drizzle-orm";
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
let origCwd: string;

vi.mock("../../server/db/index.js", () => ({
  getDb: () => db,
  schema: trackerSchema,
}));

type AnyAction = { run: (args: any) => Promise<any> };
let releaseSprint: AnyAction;

const OWNER = "owner@example.com";
const ORG_ID = "org-m5-release";

function asUser(fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: OWNER, orgId: ORG_ID }, fn);
}

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "release-sprint-"));
  // Redirect the changelog write (process.cwd()/changelog) into the temp dir.
  origCwd = process.cwd();
  process.chdir(dbDir);
  client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
  db = drizzle(client, { schema: trackerSchema });

  await client.executeMultiple(`
    CREATE TABLE tracker_sprints (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      goal TEXT DEFAULT '',
      status TEXT DEFAULT '规划',
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
  process.chdir(origCwd);
  client?.close();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.executeMultiple(`DELETE FROM tracker_sprints;`);
  fs.rmSync(path.join(dbDir, "changelog"), { recursive: true, force: true });
});

async function seedSprint(status: string) {
  const now = new Date().toISOString();
  await db.insert(trackerSchema.sprints).values({
    id: "spr_1",
    projectId: "proj-1",
    name: "Sprint M5",
    status,
    createdAt: now,
    updatedAt: now,
    ownerEmail: OWNER,
    orgId: ORG_ID,
  } as any);
}

async function fetchStatus() {
  return (
    await db
      .select({ status: trackerSchema.sprints.status })
      .from(trackerSchema.sprints)
      .where(eq(trackerSchema.sprints.id, "spr_1"))
  )[0]?.status;
}

describe("release-sprint — idempotent publish step", () => {
  it("transitions 已完成 → 已发布 and writes a changelog entry", async () => {
    await seedSprint("已完成");
    const result = await asUser(() => releaseSprint.run({ sprintId: "spr_1" }));
    expect(result.status).toBe("已发布");
    expect(result.alreadyReleased).toBe(false);
    expect(result.changelogWritten).toBe(true);
    expect(await fetchStatus()).toBe("已发布");
    // A changelog file was actually written.
    const files = fs.readdirSync(path.join(dbDir, "changelog"));
    expect(files.length).toBe(1);
  });

  it("is idempotent: releasing an already-已发布 sprint is a no-op (no error, no duplicate changelog)", async () => {
    await seedSprint("已发布");
    const result = await asUser(() => releaseSprint.run({ sprintId: "spr_1" }));
    expect(result.alreadyReleased).toBe(true);
    expect(result.changelogWritten).toBe(false);
    expect(fs.existsSync(path.join(dbDir, "changelog"))).toBe(false);
  });

  it("rejects releasing a sprint that is not 已完成", async () => {
    await seedSprint("进行中");
    await expect(
      asUser(() => releaseSprint.run({ sprintId: "spr_1" })),
    ).rejects.toThrow(/已完成/);
    expect(await fetchStatus()).toBe("进行中");
  });

  it("never writes a duplicate changelog across two release calls (deterministic filename)", async () => {
    await seedSprint("已完成");
    await asUser(() => releaseSprint.run({ sprintId: "spr_1" }));
    // Second call: sprint is now 已发布 → idempotent no-op.
    await asUser(() => releaseSprint.run({ sprintId: "spr_1" }));
    const files = fs.readdirSync(path.join(dbDir, "changelog"));
    expect(files.length).toBe(1);
  });
});
