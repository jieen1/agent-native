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

const hoisted = vi.hoisted(() => {
  const spawnEvents: MockSpawnEventRow[] = [];
  const spawns: MockSpawnRow[] = [];
  return { spawnEvents, spawns };
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
  });

  it("all-zero with no spawn_events / v3_spawns rows", async () => {
    const result = await getDisciplineMetrics("thread-1", "local@localhost");
    expect(result).toEqual({ deniedFileEdits: 0, vllmTokensToday: 0 });
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
});
