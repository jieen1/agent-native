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
import { writebackActorEmail } from "../../server/lib/writeback-actor.js";

let client: Client;
let db: LibSQLDatabase<typeof trackerSchema>;
let dbDir: string;

vi.mock("../../server/db/index.js", () => ({
  getDb: () => db,
  schema: trackerSchema,
}));

type AnyAction = { run: (args: any, ctx?: any) => Promise<any> };
let addComment: AnyAction;

const OWNER = "owner@example.com";
const ORG_ID = "org-ac";

function asUser(fn: () => Promise<any> | any, email = OWNER) {
  return runWithRequestContext({ userEmail: email, orgId: ORG_ID }, fn);
}

// Mirror transition-work-item.test.ts: omit `actionName` so the audit wrapper
// never touches the framework's real global audit DB. `actorFromCaller` only
// needs `ctx.caller`.
function ctxFor(caller: "frontend" | "tool" | "http" | "mcp", email = OWNER) {
  return { caller, userEmail: email, orgId: ORG_ID };
}

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-comment-"));
  client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
  db = drizzle(client, { schema: trackerSchema });

  await client.executeMultiple(`
    CREATE TABLE tracker_work_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'requirement',
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      priority INTEGER NOT NULL DEFAULT 0,
      orchestrator_thread_id TEXT,
      orchestrator_task_id TEXT,
      orchestrator_run_id TEXT,
      orchestrator_workspace_id TEXT,
      dispatched_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      owner_email TEXT NOT NULL,
      org_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private',
      sprint_id TEXT,
      item_key TEXT NOT NULL DEFAULT '',
      risk TEXT NOT NULL DEFAULT 'medium',
      tags TEXT NOT NULL DEFAULT '[]',
      execution_mode TEXT NOT NULL DEFAULT 'manual',
      planned_stages TEXT NOT NULL DEFAULT '[]',
      current_stage_name TEXT NOT NULL DEFAULT '待办',
      branch TEXT,
      owner TEXT,
      nature TEXT NOT NULL DEFAULT '[]',
      exec_state TEXT,
      closed_reason TEXT,
      closed_at TEXT,
      scale_estimate TEXT,
      split_parent_id TEXT
    );
    CREATE TABLE tracker_comments (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      author_kind TEXT DEFAULT 'human',
      author_name TEXT DEFAULT '',
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      owner_email TEXT,
      org_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
    );
    CREATE TABLE tracker_activities (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      actor_kind TEXT DEFAULT 'agent',
      actor_name TEXT DEFAULT '智能体',
      event_type TEXT NOT NULL,
      payload TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      owner_email TEXT,
      org_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
    );
  `);

  const mod = await import("../add-comment.js");
  addComment = mod.default as unknown as AnyAction;
}, 30_000);

afterAll(() => {
  client?.close();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.executeMultiple(`
    DELETE FROM tracker_activities;
    DELETE FROM tracker_comments;
    DELETE FROM tracker_work_items;
  `);
});

async function insertItem(ownerEmail = OWNER): Promise<string> {
  const now = new Date().toISOString();
  const id = `wi_${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(trackerSchema.workItems).values({
    id,
    projectId: "proj-1",
    type: "task",
    title: "Test item",
    description: "",
    status: "open",
    priority: 1,
    createdAt: now,
    updatedAt: now,
    ownerEmail,
    orgId: ORG_ID,
    itemKey: "AC-1",
    currentStageName: "待办",
  });
  return id;
}

async function fetchComment(workItemId: string) {
  const rows = await db
    .select()
    .from(trackerSchema.comments)
    .where(eq(trackerSchema.comments.workItemId, workItemId));
  return rows[0];
}

async function fetchActivity(workItemId: string) {
  const rows = await db
    .select()
    .from(trackerSchema.activities)
    .where(eq(trackerSchema.activities.workItemId, workItemId));
  return rows[0];
}

// ============================================================================
// authorKind 派生 + authorName 防伪造
// ============================================================================

describe("add-comment author identity derivation", () => {
  it("human/browser caller (frontend, non-sentinel) → authorKind=human and args.authorName overrides the display name", async () => {
    const id = await insertItem();
    await asUser(() =>
      addComment.run(
        { workItemId: id, body: "looks good", authorName: "Alice (reviewer)" },
        ctxFor("frontend"),
      ),
    );

    const comment = await fetchComment(id);
    expect(comment.authorKind).toBe("human");
    expect(comment.authorName).toBe("Alice (reviewer)");

    const activity = await fetchActivity(id);
    expect(activity.actorKind).toBe("human");
    expect(activity.actorName).toBe("Alice (reviewer)");
  });

  it("caller=tool (in-app agent loop) → authorKind=agent and a spoofed args.authorName is forced back to ownerEmail", async () => {
    const id = await insertItem();
    await asUser(() =>
      addComment.run(
        { workItemId: id, body: "人工评审通过", authorName: "Steve(评审)" },
        ctxFor("tool"),
      ),
    );

    const comment = await fetchComment(id);
    expect(comment.authorKind).toBe("agent");
    // The forged human display name must NOT be persisted.
    expect(comment.authorName).toBe(OWNER);
    expect(comment.authorName).not.toBe("Steve(评审)");

    const activity = await fetchActivity(id);
    expect(activity.actorKind).toBe("agent");
    expect(activity.actorName).toBe(OWNER);
  });

  it("caller=mcp with a non-writeback email (cross-app A2A/MCP surface) → authorKind=agent", async () => {
    const id = await insertItem();
    await asUser(() =>
      addComment.run(
        { workItemId: id, body: "auto note", authorName: "Steve(评审)" },
        ctxFor("mcp"),
      ),
    );

    const comment = await fetchComment(id);
    expect(comment.authorKind).toBe("agent");
    expect(comment.authorName).toBe(OWNER);
  });

  it("writeback sentinel (caller=mcp + email===writebackActorEmail()) → authorKind=agent", async () => {
    const sentinel = writebackActorEmail();
    const id = await insertItem(sentinel);
    await asUser(
      () =>
        addComment.run(
          {
            workItemId: id,
            body: "writeback comment",
            authorName: "Steve(评审)",
          },
          ctxFor("mcp", sentinel),
        ),
      sentinel,
    );

    const comment = await fetchComment(id);
    expect(comment.authorKind).toBe("agent");
    expect(comment.authorName).toBe(sentinel);
  });

  it("activities row actorKind/actorName stay consistent with the comments row across surfaces", async () => {
    const id = await insertItem();
    await asUser(() =>
      addComment.run(
        { workItemId: id, body: "agent driven", authorName: "Fake Human" },
        ctxFor("tool"),
      ),
    );

    const comment = await fetchComment(id);
    const activity = await fetchActivity(id);
    expect(activity.actorKind).toBe(comment.authorKind);
    expect(activity.actorName).toBe(comment.authorName);
    expect(activity.eventType).toBe("评论");
  });
});
