// R4b.3 — planning-domain payload contract (docs/sdlc-product-design/
// r4-workflow-families-planning-skills.md §5.5). Covers the pure markdown
// helpers (extractScopeGlobsFromBrief/buildCombinedSpec) and
// resolveDispatchPayload's per-template whitelist against a real in-memory
// libsql DB (mirrors workflow-routing.test.ts's technique).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as trackerSchema from "../../db/schema.js";
import {
  buildCombinedSpec,
  extractScopeGlobsFromBrief,
  resolveDispatchPayload,
} from "../brief-payload.js";

const OWNER = "owner@example.com";
const ORG_ID = "org-r4b3";

function asUser<T>(fn: () => Promise<T> | T) {
  return runWithRequestContext({ userEmail: OWNER, orgId: ORG_ID }, fn);
}

// ── Pure markdown helpers ────────────────────────────────────────────────────

describe("extractScopeGlobsFromBrief (pure)", () => {
  it("parses paths out of a brief's own '## 涉及文件' table", () => {
    const brief = [
      "# Brief: PRJ-001 · 队列重排序",
      "",
      "实现 exec_queue.position 持久化。",
      "",
      "## 涉及文件",
      "",
      "| 文件路径 | 操作 | 说明 |",
      "| --- | --- | --- |",
      "| `actions/reorder-queue.ts` | MODIFY | 持久化顺序 |",
      "| `actions/get-queue-eta.ts` | CREATE | 计算 ETA |",
      "",
      "## 关联屏幕规格摘要",
      "",
      "S1: ...",
    ].join("\n");

    expect(extractScopeGlobsFromBrief(brief)).toEqual([
      "actions/reorder-queue.ts",
      "actions/get-queue-eta.ts",
    ]);
  });

  it("returns [] when the brief has no '## 涉及文件' section", () => {
    const brief =
      "# Brief: PRJ-001 · 队列重排序\n\n实现 exec_queue.position 持久化。\n";
    expect(extractScopeGlobsFromBrief(brief)).toEqual([]);
  });

  it("returns [] for an empty table (header + separator only)", () => {
    const brief = [
      "# Brief: PRJ-001",
      "",
      "## 涉及文件",
      "",
      "| 文件路径 | 操作 | 说明 |",
      "| --- | --- | --- |",
      "",
      "## 依赖",
    ].join("\n");
    expect(extractScopeGlobsFromBrief(brief)).toEqual([]);
  });
});

describe("buildCombinedSpec (pure)", () => {
  it("appends the shared-brief under a labeled divider when present", () => {
    const spec = buildCombinedSpec("Brief body.", "Shared conventions.");
    expect(spec).toContain("Brief body.");
    expect(spec).toContain("## 共享约定 (shared-brief)");
    expect(spec).toContain("Shared conventions.");
    expect(spec.indexOf("Brief body.")).toBeLessThan(
      spec.indexOf("Shared conventions."),
    );
  });

  it("omits the divider entirely when there is no shared-brief yet", () => {
    const spec = buildCombinedSpec("Brief body.", undefined);
    expect(spec.trim()).toBe("Brief body.");
    expect(spec).not.toContain("shared-brief");
  });
});

// ── resolveDispatchPayload — real DB, per-template whitelist (§5.5) ─────────

let client: Client;
let db: LibSQLDatabase<typeof trackerSchema>;
let dbDir: string;

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "brief-payload-"));
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
  `);

  await db.insert(trackerSchema.sprints).values({
    id: "sprint-1",
    projectId: "proj-1",
    name: "Sprint 1",
    goal: "把队列排序做成持久化",
    status: "进行中",
    phase: "designing",
    startDate: "",
    endDate: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ownerEmail: OWNER,
    orgId: ORG_ID,
  });
});

afterAll(() => {
  client?.close();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.executeMultiple(`DELETE FROM tracker_sprint_artifacts;`);
});

async function seedArtifact(docKey: string, content: string, kind = "文档") {
  await db.insert(trackerSchema.sprintArtifacts).values({
    id: `art-${docKey}-${Math.random().toString(36).slice(2, 8)}`,
    sprintId: "sprint-1",
    docKey,
    kind,
    name: docKey,
    version: 1,
    producedByKind: "agent",
    content,
    createdAt: new Date().toISOString(),
    ownerEmail: OWNER,
    orgId: ORG_ID,
  });
}

const BRIEF_CONTENT = [
  "# Brief: PRJ-001 · 队列重排序",
  "",
  "实现 exec_queue.position 持久化。",
  "",
  "## 涉及文件",
  "",
  "| 文件路径 | 操作 | 说明 |",
  "| --- | --- | --- |",
  "| `actions/reorder-queue.ts` | MODIFY | 持久化顺序 |",
].join("\n");

describe("resolveDispatchPayload — row 1 (sdlc-issue-pipeline/quick-task/hotfix)", () => {
  for (const templateName of ["sdlc-issue-pipeline", "quick-task", "hotfix"]) {
    it(`${templateName}: returns {spec, scopeGlobs} built from brief+shared-brief when a brief exists`, async () => {
      await seedArtifact("brief:PRJ-001", BRIEF_CONTENT);
      await seedArtifact("shared-brief", "统一命名约定。");

      const payload = await asUser(() =>
        resolveDispatchPayload(db, {
          sprintId: "sprint-1",
          itemKey: "PRJ-001",
          templateName,
        }),
      );

      expect(payload.spec).toContain("实现 exec_queue.position 持久化");
      expect(payload.spec).toContain("统一命名约定");
      expect(payload.scopeGlobs).toEqual(["actions/reorder-queue.ts"]);
    });
  }

  it("returns {} (falls back to raw description) when no brief has been extracted yet", async () => {
    const payload = await asUser(() =>
      resolveDispatchPayload(db, {
        sprintId: "sprint-1",
        itemKey: "PRJ-999",
        templateName: "sdlc-issue-pipeline",
      }),
    );
    expect(payload).toEqual({});
  });

  it("never leaks tech-design/sprint-doc full text — only the item's own brief + shared-brief", async () => {
    await seedArtifact("brief:PRJ-001", BRIEF_CONTENT);
    await seedArtifact(
      "tech-design",
      "# SECRET FULL TECH DESIGN — must never appear in dispatch payload",
    );
    await seedArtifact(
      "brief:PRJ-002",
      "# Brief: PRJ-002 — another item's brief, must never leak into PRJ-001's dispatch",
    );

    const payload = await asUser(() =>
      resolveDispatchPayload(db, {
        sprintId: "sprint-1",
        itemKey: "PRJ-001",
        templateName: "hotfix",
      }),
    );
    expect(payload.spec).not.toContain("SECRET FULL TECH DESIGN");
    expect(payload.spec).not.toContain("another item's brief");
  });

  it("has no scopeGlobs key when the brief declares no touched files", async () => {
    await seedArtifact(
      "brief:PRJ-002",
      "# Brief: PRJ-002 · 无文件章节\n\n只有正文,没有涉及文件小节。\n",
    );
    const payload = await asUser(() =>
      resolveDispatchPayload(db, {
        sprintId: "sprint-1",
        itemKey: "PRJ-002",
        templateName: "quick-task",
      }),
    );
    expect(payload).not.toHaveProperty("scopeGlobs");
  });
});

describe("resolveDispatchPayload — sdlc-gap-analysis", () => {
  const SPRINT_DOC_WITH_METRICS = [
    "# Sprint 1",
    "",
    "## Success Metrics",
    "",
    "- M1 | Leading | 队列排序稳定 | 无越界重排",
    "- M2 | Lagging | 排序超时下降 | p95 < 200ms",
  ].join("\n");

  it("returns {goal, goalMetrics} parsed from sprint.goal + the latest sprint-doc", async () => {
    await seedArtifact("sprint-doc", SPRINT_DOC_WITH_METRICS);

    const payload = await asUser(() =>
      resolveDispatchPayload(db, {
        sprintId: "sprint-1",
        itemKey: "PRJ-001",
        templateName: "sdlc-gap-analysis",
      }),
    );
    expect(payload.goal).toBe("把队列排序做成持久化");
    expect(payload.goalMetrics).toEqual([
      {
        id: "M1",
        type: "Leading",
        statement: "队列排序稳定",
        signal: "无越界重排",
      },
      {
        id: "M2",
        type: "Lagging",
        statement: "排序超时下降",
        signal: "p95 < 200ms",
      },
    ]);
    // §5.5 forbidden: tech-design / issue list must never appear.
    expect(payload).not.toHaveProperty("diffSummary");
  });

  it("returns {} when the sprint has no sprint-doc yet", async () => {
    const payload = await asUser(() =>
      resolveDispatchPayload(db, {
        sprintId: "sprint-1",
        itemKey: "PRJ-001",
        templateName: "sdlc-gap-analysis",
      }),
    );
    expect(payload).toEqual({});
  });
});

describe("resolveDispatchPayload — sdlc-ui-build", () => {
  it("returns {uiSpec} (full text) when a ui-spec artifact exists", async () => {
    await seedArtifact("ui-spec", "# UI Spec\n\n## S1 队列页\n\n...");
    const payload = await asUser(() =>
      resolveDispatchPayload(db, {
        sprintId: "sprint-1",
        itemKey: "PRJ-001",
        templateName: "sdlc-ui-build",
      }),
    );
    expect(payload).toEqual({ uiSpec: "# UI Spec\n\n## S1 队列页\n\n..." });
  });

  it("returns {} when no ui-spec exists yet", async () => {
    const payload = await asUser(() =>
      resolveDispatchPayload(db, {
        sprintId: "sprint-1",
        itemKey: "PRJ-001",
        templateName: "sdlc-ui-build",
      }),
    );
    expect(payload).toEqual({});
  });
});

describe("resolveDispatchPayload — non-whitelisted templates", () => {
  for (const templateName of ["docs-task", "spike-research", "sdlc-verify"]) {
    it(`${templateName}: always returns {} even when artifacts exist`, async () => {
      await seedArtifact("brief:PRJ-001", BRIEF_CONTENT);
      await seedArtifact("ui-spec", "# UI Spec");
      const payload = await asUser(() =>
        resolveDispatchPayload(db, {
          sprintId: "sprint-1",
          itemKey: "PRJ-001",
          templateName,
        }),
      );
      expect(payload).toEqual({});
    });
  }
});
