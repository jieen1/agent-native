// R4a.3 L1 — manage-project-workflow-rules.ts action tests (op-parameterized
// CRUD, mirrors manage-project-repos.ts's shape). Real in-memory libsql DB,
// same technique as dispatch-to-orchestrator.test.ts / writeback-run-meta.test.ts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { createClient, type Client } from "@libsql/client";
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

type AnyAction = { run: (args: any, ctx?: any) => Promise<any> };
let manageRules: AnyAction;

const OWNER = "owner@example.com";
const ORG_ID = "org-r4a3";

function asUser(fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: OWNER, orgId: ORG_ID }, fn);
}

beforeAll(async () => {
  dbDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "manage-project-workflow-rules-"),
  );
  client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
  db = drizzle(client, { schema: trackerSchema });

  await client.executeMultiple(`
    CREATE TABLE tracker_projects (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      git_remote TEXT NOT NULL DEFAULT '',
      default_branch TEXT NOT NULL DEFAULT 'main',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      stage_gate_config TEXT NOT NULL DEFAULT '{}',
      owner_email TEXT NOT NULL,
      org_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
    );
    CREATE TABLE tracker_project_workflow_rules (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      item_type TEXT NOT NULL DEFAULT '',
      nature TEXT NOT NULL DEFAULT '',
      in_sprint INTEGER,
      template_name TEXT NOT NULL,
      default_inputs TEXT NOT NULL DEFAULT '{}',
      priority INTEGER NOT NULL DEFAULT 100,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      owner_email TEXT NOT NULL DEFAULT 'local@localhost',
      org_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
    );
  `);

  await db.insert(trackerSchema.projects).values([
    {
      id: "proj-1",
      key: "PRJ",
      name: "Test project",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ownerEmail: OWNER,
      orgId: ORG_ID,
    },
    {
      id: "proj-2",
      key: "PRJ2",
      name: "Second test project",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ownerEmail: OWNER,
      orgId: ORG_ID,
    },
  ] as any);

  const mod = await import("../manage-project-workflow-rules.js");
  manageRules = mod.default as unknown as AnyAction;
});

afterAll(() => {
  client?.close();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.executeMultiple(`DELETE FROM tracker_project_workflow_rules;`);
});

describe("manage-project-workflow-rules", () => {
  it("op=list returns [] for a project with no rules", async () => {
    const rows = await asUser(() =>
      manageRules.run({ projectId: "proj-1", op: "list" }),
    );
    expect(rows).toEqual([]);
  });

  it("op=add creates a rule and op=list returns it", async () => {
    const added = await asUser(() =>
      manageRules.run({
        projectId: "proj-1",
        op: "add",
        rule: { itemType: "缺陷", templateName: "hotfix", priority: 10 },
      }),
    );
    expect(added.templateName).toBe("hotfix");
    expect(added.itemType).toBe("缺陷");

    const rows = await asUser(() =>
      manageRules.run({ projectId: "proj-1", op: "list" }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(added.id);
  });

  it("op=update patches an existing rule by id", async () => {
    const added = await asUser(() =>
      manageRules.run({
        projectId: "proj-1",
        op: "add",
        rule: { templateName: "quick-task", priority: 100 },
      }),
    );
    const updated = await asUser(() =>
      manageRules.run({
        projectId: "proj-1",
        op: "update",
        rule: { id: added.id, priority: 5, templateName: "hotfix" },
      }),
    );
    expect(updated.priority).toBe(5);
    expect(updated.templateName).toBe("hotfix");
  });

  it("op=remove deletes a rule by id", async () => {
    const added = await asUser(() =>
      manageRules.run({
        projectId: "proj-1",
        op: "add",
        rule: { templateName: "docs-task" },
      }),
    );
    const removed = await asUser(() =>
      manageRules.run({
        projectId: "proj-1",
        op: "remove",
        rule: { id: added.id },
      }),
    );
    expect(removed).toEqual({ deleted: true, id: added.id });

    const rows = await asUser(() =>
      manageRules.run({ projectId: "proj-1", op: "list" }),
    );
    expect(rows).toEqual([]);
  });

  it("rejects op=update when the rule id belongs to a DIFFERENT (real) project", async () => {
    const added = await asUser(() =>
      manageRules.run({
        projectId: "proj-1",
        op: "add",
        rule: { templateName: "quick-task" },
      }),
    );
    await expect(
      asUser(() =>
        manageRules.run({
          projectId: "proj-2", // a real project, but doesn't own this rule
          op: "update",
          rule: { id: added.id, templateName: "hotfix" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects any op when the project itself doesn't exist", async () => {
    await expect(
      asUser(() =>
        manageRules.run({ projectId: "proj-does-not-exist", op: "list" }),
      ),
    ).rejects.toThrow(/not found/);
  });

  it("stores defaultInputs as JSON and round-trips it through list", async () => {
    await asUser(() =>
      manageRules.run({
        projectId: "proj-1",
        op: "add",
        rule: {
          templateName: "spike-research",
          defaultInputs: { goal: "评估方案" },
        },
      }),
    );
    const rows = await asUser(() =>
      manageRules.run({ projectId: "proj-1", op: "list" }),
    );
    expect(JSON.parse(rows[0].defaultInputs)).toEqual({ goal: "评估方案" });
  });
});
