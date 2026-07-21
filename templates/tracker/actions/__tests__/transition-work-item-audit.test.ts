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

// ============================================================================
// T-F3-13: audit 落库
//
// "前置: action 须声明 audit.target={type:'work-item', id},否则 targetId 落
// null 而本断言恒红" — so this file asserts BOTH:
//   (a) the CONTRACT: transition-work-item's exported `audit.target(...)`
//       resolves to exactly {type:"work-item", id}. Fast, deterministic,
//       no DB.
//   (b) the REAL end-to-end pipeline: calling .run(args, ctx) with a real
//       actionName (so defineAction's audit wrapper actually fires) lands a
//       row in the framework's real audit store, queryable via
//       queryAuditEvents (both @agent-native/core/audit exports — NOT
//       mocked, this is the genuine pipeline).
//
// SAFETY: the framework's audit store uses a process-wide getDbExec()
// singleton that defaults to `file:./data/app.db` relative to CWD — this
// template's REAL local dev database. This file sets DATABASE_URL to an
// isolated throwaway file for its own lifetime (restored in afterAll) so it
// can NEVER read/write the real dev DB. Every other F3 test file
// deliberately omits `ctx.actionName` to avoid ever triggering this pipeline
// at all — see the comment in transition-work-item.test.ts's ctxFor().
// ============================================================================

let client: Client;
let db: LibSQLDatabase<typeof trackerSchema>;
let dbDir: string;
let dbPath: string;
let originalDatabaseUrl: string | undefined;

vi.mock("../../server/db/index.js", () => ({
  getDb: () => db,
  schema: trackerSchema,
}));

type AnyAction = {
  run: (args: any, ctx?: any) => Promise<any>;
  audit?: {
    target?: (
      args: any,
      result: unknown,
      meta: unknown,
    ) => { type?: string; id?: string } | null;
  };
};
let transitionWorkItem: AnyAction;

const OWNER = "owner@example.com";
const ORG_ID = "org-f3";

function asUser(fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: OWNER, orgId: ORG_ID }, fn);
}

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "transition-audit-"));
  dbPath = path.join(dbDir, "test.db");
  originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = `file:${dbPath}`;

  client = createClient({ url: `file:${dbPath}` });
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

  const mod = await import("../transition-work-item.js");
  transitionWorkItem = mod.default as unknown as AnyAction;
}, 30_000);

afterAll(async () => {
  client?.close();
  fs.rmSync(dbDir, { recursive: true, force: true });
  const { closeDbExec } = await import("@agent-native/core/db");
  await closeDbExec?.().catch(() => {});
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

beforeEach(async () => {
  await client.executeMultiple(`
    DELETE FROM tracker_activities;
    DELETE FROM tracker_work_items;
  `);
});

async function insertItem(id: string) {
  const now = new Date().toISOString();
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
    ownerEmail: OWNER,
    orgId: ORG_ID,
    itemKey: "F3-1",
    currentStageName: "待办",
  });
}

describe("T-F3-13a: audit.target 声明前置(contract, no DB)", () => {
  it("transition-work-item declares audit.target returning exactly {type:'work-item', id}", () => {
    expect(transitionWorkItem.audit).toBeTruthy();
    expect(typeof transitionWorkItem.audit!.target).toBe("function");
    const target = transitionWorkItem.audit!.target!(
      { id: "wi-42", target: "closed", reason: "test" },
      { noop: false },
      { status: "success", caller: "frontend" },
    );
    expect(target).toEqual({ type: "work-item", id: "wi-42" });
  });
});

describe("T-F3-13b: audit 落库(real pipeline, isolated DB)", () => {
  it("a successful human transition writes exactly one audit row: actorKind=human, actorEmail=JWT user, action=transition-work-item, targetId=work item id, input contains reason", async () => {
    const id = "wi-audit-1";
    await insertItem(id);

    await asUser(() =>
      transitionWorkItem.run(
        { id, target: "closed", reason: "关闭:审计落库验证" },
        {
          caller: "frontend",
          actionName: "transition-work-item",
          userEmail: OWNER,
          orgId: ORG_ID,
        },
      ),
    );

    const { queryAuditEvents, getAuditEventById } =
      await import("@agent-native/core/audit");
    const events = await queryAuditEvents(
      { userEmail: OWNER, orgId: ORG_ID },
      { action: "transition-work-item", targetId: id },
    );

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.actorKind).toBe("human");
    expect(event.actorEmail).toBe(OWNER);
    expect(event.action).toBe("transition-work-item");
    expect(event.targetType).toBe("work-item");
    expect(event.targetId).toBe(id);
    expect(event.status).toBe("success");

    // The list surface (queryAuditEvents) deliberately EXCLUDES `input` (see
    // packages/core/src/audit/store.ts's LIST_COLUMNS comment — a timeline
    // query must never stream every event's redacted body in bulk). Fetch the
    // full row by id to check input contains the reason.
    const full = await getAuditEventById(event.id, {
      userEmail: OWNER,
      orgId: ORG_ID,
    });
    expect(full).toBeTruthy();
    expect(full!.input).toBeTruthy();
    expect(String(full!.input)).toContain("关闭:审计落库验证");
  }, 15_000);

  it("an agent (tool caller) DENIED attempt still records — actorKind=agent, status=error", async () => {
    const id = "wi-audit-2";
    await insertItem(id);

    await expect(
      asUser(() =>
        transitionWorkItem.run(
          {
            id,
            target: "done",
            reason: "agent 尝试自动完成",
            verdict: "PASSED",
            evidence: { commit: "abcdef1" },
          },
          {
            caller: "tool",
            actionName: "transition-work-item",
            userEmail: OWNER,
            orgId: ORG_ID,
          },
        ),
      ),
    ).rejects.toThrow();

    const { queryAuditEvents } = await import("@agent-native/core/audit");
    const events = await queryAuditEvents(
      { userEmail: OWNER, orgId: ORG_ID },
      { action: "transition-work-item", targetId: id },
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.actorKind).toBe("agent");
    expect(events[0]!.status).toBe("error");
  }, 15_000);
});
