// Exercises pause-scheduler / resume-scheduler / get-queue-health against a
// REAL isolated settings store (an ephemeral SQLite file), the same way
// server/plugins/__tests__/db-migration.test.ts isolates core's getDbExec()
// singleton — never the developer's real local data/app.db.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWithRequestContext } from "@agent-native/core/server/request-context";
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

let dbDir: string;
let dbPath: string;
let originalDatabaseUrl: string | undefined;

const mockCallOrchestratorTool = vi.fn();
vi.mock("../../server/lib/orchestrator-client.js", () => ({
  callOrchestratorTool: (...args: unknown[]) =>
    mockCallOrchestratorTool(...args),
}));

type AnyAction = { run: (args: any) => Promise<any> };
let pauseScheduler: AnyAction;
let resumeScheduler: AnyAction;
let getQueueHealth: AnyAction;

const OWNER = "owner@example.com";

function asUser(fn: () => Promise<any> | any) {
  return runWithRequestContext({ userEmail: OWNER, orgId: null }, fn);
}

beforeAll(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-test-"));
  dbPath = path.join(dbDir, "settings.db");
  originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = `file:${dbPath}`;

  const pauseMod = await import("../pause-scheduler.js");
  pauseScheduler = pauseMod.default as unknown as AnyAction;
  const resumeMod = await import("../resume-scheduler.js");
  resumeScheduler = resumeMod.default as unknown as AnyAction;
  const healthMod = await import("../get-queue-health.js");
  getQueueHealth = healthMod.default as unknown as AnyAction;
}, 30_000);

afterAll(async () => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  const { closeDbExec } = await import("@agent-native/core/db");
  await closeDbExec?.().catch(() => {});
  fs.rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(() => {
  mockCallOrchestratorTool.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pause-scheduler / resume-scheduler", () => {
  it("pause persists paused:true with pausedAt/pausedBy", async () => {
    const result = await asUser(() => pauseScheduler.run({}));
    expect(result.paused).toBe(true);
    expect(result.pausedBy).toBe(OWNER);
    expect(typeof result.pausedAt).toBe("string");
  });

  it("resume persists paused:false and clears pausedAt/pausedBy", async () => {
    await asUser(() => pauseScheduler.run({}));
    const result = await asUser(() => resumeScheduler.run({}));
    expect(result.paused).toBe(false);
    expect(result.pausedAt).toBeNull();
    expect(result.pausedBy).toBeNull();
    expect(result.resumedBy).toBe(OWNER);
  });

  it("state survives across separate calls (real persistence, not client state)", async () => {
    await asUser(() => pauseScheduler.run({}));
    mockCallOrchestratorTool.mockResolvedValue({
      data: { claudeCodeLoggedIn: true, claudeCodeExpired: false },
    });
    const health = await asUser(() => getQueueHealth.run({}));
    expect(health.scheduler.paused).toBe(true);
  });

  it("throws when unauthenticated", async () => {
    await expect(pauseScheduler.run({})).rejects.toThrow(/Not authenticated/);
    await expect(resumeScheduler.run({})).rejects.toThrow(/Not authenticated/);
  });
});

describe("get-queue-health", () => {
  it("combines scheduler state + orchestrator get-runtime-status + brain-queue-status", async () => {
    await asUser(() => resumeScheduler.run({}));
    mockCallOrchestratorTool.mockImplementation(
      (_owner: string, tool: string) => {
        if (tool === "get-runtime-status") {
          return Promise.resolve({
            data: {
              claudeCodeLoggedIn: true,
              claudeCodeExpired: false,
              claudeCodeSubscription: "max",
              chatEngine: "ai-sdk:openai",
              chatModel: "qwen-coder",
              chatBaseUrl: "http://vllm:8000/v1",
            },
          });
        }
        if (tool === "brain-queue-status") {
          return Promise.resolve({
            data: {
              brainConcurrency: 2,
              running: 1,
              queued: 3,
              driverAlive: true,
              lastTickAt: "2026-07-17T00:00:00.000Z",
              lastError: null,
            },
          });
        }
        throw new Error(`unexpected tool ${tool}`);
      },
    );

    const health = await asUser(() => getQueueHealth.run({}));
    expect(health.orchestratorReachable).toBe(true);
    expect(health.scheduler.paused).toBe(false);
    expect(health.claudeCode).toEqual({
      loggedIn: true,
      expired: false,
      subscription: "max",
    });
    expect(health.devEngine).toEqual({
      engine: "ai-sdk:openai",
      model: "qwen-coder",
      baseUrl: "http://vllm:8000/v1",
      configured: true,
    });
    expect(health.brain).toEqual({
      driverAlive: true,
      concurrency: 2,
      running: 1,
      queued: 3,
      lastError: null,
      lastTickAt: "2026-07-17T00:00:00.000Z",
    });
  });

  it("degrades to orchestratorReachable:false on MCP failure instead of fabricating a healthy status", async () => {
    mockCallOrchestratorTool.mockRejectedValue(
      new Error("connect ECONNREFUSED"),
    );
    const health = await asUser(() => getQueueHealth.run({}));
    expect(health.orchestratorReachable).toBe(false);
    expect(health.orchestratorError).toMatch(/ECONNREFUSED/);
    expect(health.claudeCode).toBeNull();
    expect(health.brain).toBeNull();
  });

  it("throws when unauthenticated", async () => {
    await expect(getQueueHealth.run({})).rejects.toThrow(/Not authenticated/);
  });
});
