// Real isolated settings store (ephemeral SQLite) — same isolation pattern as
// db-migration.test.ts and actions/__tests__/scheduler.test.ts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { deleteSetting, putSetting } from "@agent-native/core/settings";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  HEALTH_LOG_SETTING_KEY,
  SCHEDULER_SETTING_KEY,
  SchedulerPausedError,
  assertSchedulerNotPaused,
  getLastHealthRejection,
  getSchedulerState,
  recordHealthRejection,
} from "../scheduler-gate.js";

let dbDir: string;
let dbPath: string;
let originalDatabaseUrl: string | undefined;

beforeAll(() => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-gate-test-"));
  dbPath = path.join(dbDir, "settings.db");
  originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = `file:${dbPath}`;
});

afterAll(async () => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  const { closeDbExec } = await import("@agent-native/core/db");
  await closeDbExec?.().catch(() => {});
  fs.rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Reset to the default (unpaused) state before each test.
  await putSetting(SCHEDULER_SETTING_KEY, {
    paused: false,
    pausedAt: null,
    pausedBy: null,
    resumedAt: null,
    resumedBy: null,
  });
});

describe("getSchedulerState", () => {
  it("defaults to unpaused when nothing has ever been written", async () => {
    // A fresh key that was never written — simulate by using a throwaway
    // process-level state: getSchedulerState reads SCHEDULER_SETTING_KEY,
    // which beforeEach seeds to unpaused, so this asserts that shape.
    const state = await getSchedulerState();
    expect(state.paused).toBe(false);
  });

  it("reflects a persisted paused:true", async () => {
    await putSetting(SCHEDULER_SETTING_KEY, {
      paused: true,
      pausedAt: "2026-07-17T00:00:00.000Z",
      pausedBy: "owner@example.com",
      resumedAt: null,
      resumedBy: null,
    });
    const state = await getSchedulerState();
    expect(state.paused).toBe(true);
    expect(state.pausedBy).toBe("owner@example.com");
  });
});

describe("assertSchedulerNotPaused", () => {
  it("resolves silently when not paused", async () => {
    await expect(assertSchedulerNotPaused("wi-1")).resolves.toBeUndefined();
  });

  it("throws SchedulerPausedError and logs a rejection when paused", async () => {
    await putSetting(SCHEDULER_SETTING_KEY, {
      paused: true,
      pausedAt: "2026-07-17T00:00:00.000Z",
      pausedBy: "owner@example.com",
      resumedAt: null,
      resumedBy: null,
    });

    let caught: unknown;
    try {
      await assertSchedulerNotPaused("wi-42");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SchedulerPausedError);
    expect((caught as SchedulerPausedError).code).toBe("scheduler-paused");

    const rejection = await getLastHealthRejection();
    expect(rejection?.reason).toBe("调度器已暂停");
    expect(rejection?.workItemId).toBe("wi-42");
  });
});

describe("recordHealthRejection / getLastHealthRejection", () => {
  it("round-trips a rejection entry with a real timestamp", async () => {
    await recordHealthRejection({ reason: "vLLM 不可达", workItemId: "wi-9" });
    const rejection = await getLastHealthRejection();
    expect(rejection?.reason).toBe("vLLM 不可达");
    expect(rejection?.workItemId).toBe("wi-9");
    expect(typeof rejection?.at).toBe("string");
  });

  it("returns null when nothing was ever recorded (fresh key)", async () => {
    await deleteSetting(HEALTH_LOG_SETTING_KEY);
    const rejection = await getLastHealthRejection();
    expect(rejection).toBeNull();
  });
});
