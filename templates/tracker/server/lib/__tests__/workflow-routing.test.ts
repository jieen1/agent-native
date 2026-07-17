// R4a.3 L1 — deterministic pre-selection routing tests (design authority:
// docs/sdlc-product-design/r4-workflow-families-planning-skills.md §4.4
// first bullet).
//
// Covers: the pure matcher (matchesWorkflowRule/findFirstMatch), the
// documented DEFAULT_WORKFLOW_RULES table (需求/任务(sprint 内)→
// sdlc-issue-pipeline; 缺陷/生产问题→hotfix; from-audit→hotfix; 文档→
// docs-task; 调研→spike-research; 无 sprint→quick-task), and
// resolveWorkflowRule's project-row-overrides-default precedence against a
// real in-memory libsql DB (mirrors dispatch-to-orchestrator.test.ts's
// technique).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as trackerSchema from "../../db/schema.js";
import {
  DEFAULT_WORKFLOW_RULES,
  matchesWorkflowRule,
  findFirstMatch,
  resolveWorkflowRule,
  type WorkflowRuleSpec,
  type WorkflowRuleMatchContext,
} from "../workflow-routing.js";

const OWNER = "owner@example.com";
const ORG_ID = "org-r4a3";

function asUser<T>(fn: () => Promise<T> | T) {
  return runWithRequestContext({ userEmail: OWNER, orgId: ORG_ID }, fn);
}

// ── Pure matcher ─────────────────────────────────────────────────────────────

describe("matchesWorkflowRule (pure)", () => {
  const ctx: WorkflowRuleMatchContext = {
    itemType: "需求",
    natureCandidates: ["需求"],
    inSprint: true,
  };

  it("wildcards (empty string / null) match anything on that dimension", () => {
    const rule: WorkflowRuleSpec = {
      itemType: "",
      nature: "",
      inSprint: null,
      templateName: "quick-task",
      defaultInputs: {},
      priority: 100,
    };
    expect(matchesWorkflowRule(rule, ctx)).toBe(true);
  });

  it("a set itemType must match exactly", () => {
    const rule: WorkflowRuleSpec = {
      itemType: "缺陷",
      nature: "",
      inSprint: null,
      templateName: "hotfix",
      defaultInputs: {},
      priority: 30,
    };
    expect(matchesWorkflowRule(rule, ctx)).toBe(false);
  });

  it("a set nature must appear among the context's nature candidates", () => {
    const rule: WorkflowRuleSpec = {
      itemType: "",
      nature: "文档",
      inSprint: null,
      templateName: "docs-task",
      defaultInputs: {},
      priority: 20,
    };
    expect(matchesWorkflowRule(rule, ctx)).toBe(false);
    expect(
      matchesWorkflowRule(rule, { ...ctx, natureCandidates: ["需求", "文档"] }),
    ).toBe(true);
  });

  it("a set inSprint must match the tri-state exactly", () => {
    const requiresInSprint: WorkflowRuleSpec = {
      itemType: "",
      nature: "",
      inSprint: true,
      templateName: "sdlc-issue-pipeline",
      defaultInputs: {},
      priority: 40,
    };
    expect(matchesWorkflowRule(requiresInSprint, ctx)).toBe(true);
    expect(
      matchesWorkflowRule(requiresInSprint, { ...ctx, inSprint: false }),
    ).toBe(false);
  });
});

describe("findFirstMatch (pure)", () => {
  it("picks the lowest-priority-number match, regardless of array order", () => {
    const rules: WorkflowRuleSpec[] = [
      {
        itemType: "",
        nature: "",
        inSprint: null,
        templateName: "low-pri",
        defaultInputs: {},
        priority: 100,
      },
      {
        itemType: "需求",
        nature: "",
        inSprint: null,
        templateName: "high-pri",
        defaultInputs: {},
        priority: 10,
      },
    ];
    const ctx: WorkflowRuleMatchContext = {
      itemType: "需求",
      natureCandidates: ["需求"],
      inSprint: false,
    };
    expect(findFirstMatch(rules, ctx)?.templateName).toBe("high-pri");
  });

  it("returns null when nothing matches", () => {
    const rules: WorkflowRuleSpec[] = [
      {
        itemType: "缺陷",
        nature: "",
        inSprint: null,
        templateName: "hotfix",
        defaultInputs: {},
        priority: 30,
      },
    ];
    const ctx: WorkflowRuleMatchContext = {
      itemType: "需求",
      natureCandidates: ["需求"],
      inSprint: false,
    };
    expect(findFirstMatch(rules, ctx)).toBeNull();
  });
});

// ── DEFAULT_WORKFLOW_RULES — the s8 prototype's documented routing table ────

describe("DEFAULT_WORKFLOW_RULES (s8 routing table)", () => {
  function pick(ctx: WorkflowRuleMatchContext): string | undefined {
    return findFirstMatch(DEFAULT_WORKFLOW_RULES, ctx)?.templateName;
  }

  it("需求 in a sprint → sdlc-issue-pipeline", () => {
    expect(
      pick({ itemType: "需求", natureCandidates: ["需求"], inSprint: true }),
    ).toBe("sdlc-issue-pipeline");
  });

  it("任务 in a sprint → sdlc-issue-pipeline", () => {
    expect(
      pick({ itemType: "任务", natureCandidates: ["任务"], inSprint: true }),
    ).toBe("sdlc-issue-pipeline");
  });

  it("缺陷 (any sprint state) → hotfix", () => {
    expect(
      pick({ itemType: "缺陷", natureCandidates: ["缺陷"], inSprint: true }),
    ).toBe("hotfix");
    expect(
      pick({ itemType: "缺陷", natureCandidates: ["缺陷"], inSprint: false }),
    ).toBe("hotfix");
  });

  it("生产问题 (any sprint state) → hotfix", () => {
    expect(
      pick({
        itemType: "生产问题",
        natureCandidates: ["生产问题"],
        inSprint: false,
      }),
    ).toBe("hotfix");
  });

  it("from-audit → hotfix (takes precedence even if in a sprint)", () => {
    expect(
      pick({
        itemType: "from-audit",
        natureCandidates: ["from-audit"],
        inSprint: true,
      }),
    ).toBe("hotfix");
  });

  it("文档 tag → docs-task", () => {
    expect(
      pick({
        itemType: "需求",
        natureCandidates: ["需求", "文档"],
        inSprint: true,
      }),
    ).toBe("docs-task");
  });

  it("调研 tag → spike-research", () => {
    expect(
      pick({
        itemType: "任务",
        natureCandidates: ["任务", "调研"],
        inSprint: false,
      }),
    ).toBe("spike-research");
  });

  it("no sprint (auto/ad hoc, no other match) → quick-task", () => {
    expect(
      pick({ itemType: "需求", natureCandidates: ["需求"], inSprint: false }),
    ).toBe("quick-task");
  });

  it("is total — always resolves something, even for an unmodeled itemType/nature combo", () => {
    expect(
      pick({ itemType: "集合", natureCandidates: ["集合"], inSprint: true }),
    ).toBe("quick-task");
  });
});

// ── resolveWorkflowRule — project rows override the default table ──────────

let client: Client;
let db: LibSQLDatabase<typeof trackerSchema>;
let dbDir: string;

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-routing-"));
  client = createClient({ url: `file:${path.join(dbDir, "test.db")}` });
  db = drizzle(client, { schema: trackerSchema });

  await client.executeMultiple(`
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
});

afterAll(() => {
  client?.close();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await client.executeMultiple(`DELETE FROM tracker_project_workflow_rules;`);
});

describe("resolveWorkflowRule (DB-backed)", () => {
  it("falls back to the DEFAULT_WORKFLOW_RULES table when the project has no rows", async () => {
    const result = await asUser(() =>
      resolveWorkflowRule(db as any, {
        projectId: "proj-1",
        itemType: "缺陷",
        tags: [],
        natureTags: [],
        inSprint: false,
      }),
    );
    expect(result.templateName).toBe("hotfix");
    expect(result.source).toBe("default");
  });

  it("a project-specific rule OVERRIDES the default for the same match", async () => {
    const now = new Date().toISOString();
    await db.insert(trackerSchema.projectWorkflowRules).values({
      id: "rule-1",
      projectId: "proj-1",
      itemType: "缺陷",
      nature: "",
      inSprint: null,
      templateName: "sdlc-verify", // overrides the default "hotfix"
      defaultInputs: "{}",
      priority: 5, // more specific than the default's priority 30
      createdAt: now,
      updatedAt: now,
      ownerEmail: OWNER,
      orgId: ORG_ID,
    } as any);

    const result = await asUser(() =>
      resolveWorkflowRule(db as any, {
        projectId: "proj-1",
        itemType: "缺陷",
        tags: [],
        natureTags: [],
        inSprint: false,
      }),
    );
    expect(result.templateName).toBe("sdlc-verify");
    expect(result.source).toBe("project");
    expect(result.ruleId).toBe("rule-1");
  });

  it("does not apply another project's rules (project-scoped)", async () => {
    const now = new Date().toISOString();
    await db.insert(trackerSchema.projectWorkflowRules).values({
      id: "rule-other",
      projectId: "proj-OTHER",
      itemType: "缺陷",
      nature: "",
      inSprint: null,
      templateName: "sdlc-verify",
      defaultInputs: "{}",
      priority: 5,
      createdAt: now,
      updatedAt: now,
      ownerEmail: OWNER,
      orgId: ORG_ID,
    } as any);

    const result = await asUser(() =>
      resolveWorkflowRule(db as any, {
        projectId: "proj-1",
        itemType: "缺陷",
        tags: [],
        natureTags: [],
        inSprint: false,
      }),
    );
    expect(result.source).toBe("default");
    expect(result.templateName).toBe("hotfix");
  });

  it("carries defaultInputs from a matched project rule", async () => {
    const now = new Date().toISOString();
    await db.insert(trackerSchema.projectWorkflowRules).values({
      id: "rule-inputs",
      projectId: "proj-1",
      itemType: "调研",
      nature: "",
      inSprint: null,
      templateName: "spike-research",
      defaultInputs: JSON.stringify({ goal: "评估方案" }),
      priority: 5,
      createdAt: now,
      updatedAt: now,
      ownerEmail: OWNER,
      orgId: ORG_ID,
    } as any);

    const result = await asUser(() =>
      resolveWorkflowRule(db as any, {
        projectId: "proj-1",
        itemType: "调研",
        tags: [],
        natureTags: [],
        inSprint: false,
      }),
    );
    expect(result.defaultInputs).toEqual({ goal: "评估方案" });
  });
});
