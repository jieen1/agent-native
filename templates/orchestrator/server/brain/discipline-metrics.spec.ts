// S9 Brain console "纪律指标" card (04 §6) — unit tests for
// getDisciplineMetrics's two server-computed counters (deniedFileEdits,
// vllmTokensToday). workflowRun-call count is client-computed from the
// transcript and has no server-side counterpart to test here.

import { describe, it, expect, vi, beforeEach } from "vitest";

interface MockSpawnEventRow {
  id: string;
  spawnId: string;
  seq: number;
  type: string;
}

interface MockSpawnRow {
  engineRef: string | null;
  modelRef: string | null;
  tokensInput: number;
  tokensOutput: number;
  usageSuspect: number;
  ownerEmail: string;
  startedAt: Date;
}

// R4a.3 L2 (templateDeviationCount) fixtures — a run row (tags + templateId)
// joined in JS against a template row (id + name), mirroring the leftJoin the
// real getDisciplineMetrics query performs against Postgres.
interface MockRunRow {
  tags: Record<string, unknown> | null;
  templateId: string | null;
}
interface MockTemplateRow {
  id: string;
  name: string;
}

const hoisted = vi.hoisted(() => {
  const spawnEvents: MockSpawnEventRow[] = [];
  const spawns: MockSpawnRow[] = [];
  const runs: MockRunRow[] = [];
  const templates: MockTemplateRow[] = [];
  return { spawnEvents, spawns, runs, templates };
});

vi.mock("../db/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/index.js")>();
  function isSpawnEventsTable(table: unknown): boolean {
    return (
      table !== null && typeof table === "object" && "seq" in (table as object)
    );
  }
  function isSpawnsTable(table: unknown): boolean {
    return (
      table !== null &&
      typeof table === "object" &&
      "renderedPrompt" in (table as object)
    );
  }
  function isRunsTable(table: unknown): boolean {
    return (
      table !== null &&
      typeof table === "object" &&
      "dagVersion" in (table as object)
    );
  }
  return {
    ...actual,
    getV3Db: vi.fn(() => ({
      select: () => ({
        from: (table: unknown) => ({
          where: (_filter: unknown) => ({
            limit: (n: number) => {
              if (isSpawnEventsTable(table))
                return hoisted.spawnEvents.slice(0, n);
              if (isSpawnsTable(table)) return hoisted.spawns.slice(0, n);
              return [];
            },
          }),
          // Only v3Runs.leftJoin(v3WorkflowTemplates, ...) is exercised by the
          // real code (templateDeviationCount) — join in JS against the
          // fixture templates by id, mirroring the real SQL join's shape.
          leftJoin: (_joinTable: unknown, _cond: unknown) => ({
            where: (_filter: unknown) => ({
              limit: (n: number) => {
                if (!isRunsTable(table)) return [];
                return hoisted.runs.slice(0, n).map((r) => ({
                  tags: r.tags,
                  templateName:
                    hoisted.templates.find((t) => t.id === r.templateId)
                      ?.name ?? null,
                }));
              },
            }),
          }),
        }),
      }),
    })),
  };
});

import { getDisciplineMetrics } from "./discipline-metrics.js";

function makeSpawnEvent(
  overrides: Partial<MockSpawnEventRow> = {},
): MockSpawnEventRow {
  return {
    id: "se-1",
    spawnId: "brain:thread-1",
    seq: 0,
    type: "tool.denied",
    ...overrides,
  };
}

function makeSpawn(overrides: Partial<MockSpawnRow> = {}): MockSpawnRow {
  return {
    engineRef: "ai-sdk:vllm",
    modelRef: "qwen3.6",
    tokensInput: 100,
    tokensOutput: 200,
    usageSuspect: 0,
    ownerEmail: "local@localhost",
    startedAt: new Date(),
    ...overrides,
  };
}

describe("getDisciplineMetrics", () => {
  beforeEach(() => {
    hoisted.spawnEvents.length = 0;
    hoisted.spawns.length = 0;
    hoisted.runs.length = 0;
    hoisted.templates.length = 0;
  });

  it("all-zero with no spawn_events / v3_spawns rows", async () => {
    const result = await getDisciplineMetrics("thread-1", "local@localhost");
    expect(result).toEqual({
      deniedFileEdits: 0,
      vllmTokensToday: 0,
      templateDeviationCount: 0,
    });
  });

  it("counts only tool.denied rows for THIS thread's brain: spawn key", async () => {
    hoisted.spawnEvents.push(
      makeSpawnEvent({ id: "se-1", type: "tool.denied" }),
      makeSpawnEvent({ id: "se-2", type: "tool.denied" }),
      makeSpawnEvent({ id: "se-3", type: "tool_use" }),
    );
    const result = await getDisciplineMetrics("thread-1", "local@localhost");
    expect(result.deniedFileEdits).toBe(2);
  });

  it("sums vLLM tokens (input+output) across matching spawns", async () => {
    hoisted.spawns.push(
      makeSpawn({ tokensInput: 100, tokensOutput: 200 }),
      makeSpawn({ tokensInput: 50, tokensOutput: 25 }),
    );
    const result = await getDisciplineMetrics("thread-1", "local@localhost");
    expect(result.vllmTokensToday).toBe(375);
  });

  it("excludes usage-suspect rows from the vLLM token sum (04 §10 telemetry-trust contract)", async () => {
    hoisted.spawns.push(
      makeSpawn({ tokensInput: 100, tokensOutput: 200, usageSuspect: 0 }),
      makeSpawn({ tokensInput: 999, tokensOutput: 999, usageSuspect: 1 }),
    );
    const result = await getDisciplineMetrics("thread-1", "local@localhost");
    expect(result.vllmTokensToday).toBe(300);
  });

  it("excludes non-vLLM spawns (e.g. claude-code) from the vLLM token sum", async () => {
    hoisted.spawns.push(
      makeSpawn({
        engineRef: "ai-sdk:vllm",
        modelRef: "qwen3.6",
        tokensInput: 100,
        tokensOutput: 100,
      }),
      makeSpawn({
        engineRef: "acp:claude-code",
        modelRef: "claude-sonnet-5",
        tokensInput: 500,
        tokensOutput: 500,
      }),
    );
    const result = await getDisciplineMetrics("thread-1", "local@localhost");
    expect(result.vllmTokensToday).toBe(200);
  });

  // R4a.3 L2 — templateDeviationCount (§4.4 second/fifth bullet: leave-a-
  // trace counter, not a blocking mechanism).
  describe("templateDeviationCount", () => {
    it("counts a run whose real template differs from tags.suggestedTemplate", async () => {
      hoisted.templates.push({ id: "tpl-1", name: "quick-task" });
      hoisted.runs.push({
        tags: { suggestedTemplate: "sdlc-issue-pipeline" },
        templateId: "tpl-1",
      });
      const result = await getDisciplineMetrics("thread-1", "local@localhost");
      expect(result.templateDeviationCount).toBe(1);
    });

    it("does not count a run whose real template matches the suggestion", async () => {
      hoisted.templates.push({ id: "tpl-1", name: "hotfix" });
      hoisted.runs.push({
        tags: { suggestedTemplate: "hotfix" },
        templateId: "tpl-1",
      });
      const result = await getDisciplineMetrics("thread-1", "local@localhost");
      expect(result.templateDeviationCount).toBe(0);
    });

    it("does not count a run with no L1 suggestion in its tags", async () => {
      hoisted.templates.push({ id: "tpl-1", name: "quick-task" });
      hoisted.runs.push({ tags: {}, templateId: "tpl-1" });
      const result = await getDisciplineMetrics("thread-1", "local@localhost");
      expect(result.templateDeviationCount).toBe(0);
    });

    it("sums across multiple runs for the thread", async () => {
      hoisted.templates.push(
        { id: "tpl-1", name: "quick-task" },
        { id: "tpl-2", name: "hotfix" },
      );
      hoisted.runs.push(
        {
          tags: { suggestedTemplate: "sdlc-issue-pipeline" },
          templateId: "tpl-1",
        },
        { tags: { suggestedTemplate: "hotfix" }, templateId: "tpl-2" },
        { tags: { suggestedTemplate: "docs-task" }, templateId: "tpl-1" },
      );
      const result = await getDisciplineMetrics("thread-1", "local@localhost");
      expect(result.templateDeviationCount).toBe(2);
    });
  });
});
