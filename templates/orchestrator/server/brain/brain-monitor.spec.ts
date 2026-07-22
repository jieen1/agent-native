// S9 Brain console "监控节奏" card's inline edit (04 §6) — unit test for
// setMonitorIntervalSec. monitorSweepOnce itself is exercised indirectly
// elsewhere and pulls in heavier dependencies out of scope for this addition
// — but canBrainEngineRunNow (its "can a turn run at all" gate) is a small,
// independently mockable decision worth covering directly (2026-07-22 fix).

import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const updates: Array<{ set: Record<string, unknown>; where: unknown }> = [];
  return {
    updates,
    loggedIn: false,
    runtimeSelection: null as { kind: string } | null,
  };
});

vi.mock("../db/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/index.js")>();
  return {
    ...actual,
    getV3Db: vi.fn(() => ({
      update: () => ({
        set: (set: Record<string, unknown>) => ({
          where: async (where: unknown) => {
            hoisted.updates.push({ set, where });
            return {};
          },
        }),
      }),
    })),
  };
});

vi.mock("../claude-managed-auth.js", () => ({
  getManagedClaudeStatus: () => ({ loggedIn: hoisted.loggedIn }),
}));

vi.mock("./brain-runtime.js", () => ({
  getBrainRuntimeSelection: async () => hoisted.runtimeSelection,
}));

import {
  setMonitorIntervalSec,
  canBrainEngineRunNow,
} from "./brain-monitor.js";

describe("canBrainEngineRunNow", () => {
  beforeEach(() => {
    hoisted.loggedIn = false;
    hoisted.runtimeSelection = null;
  });

  it("is true when Claude Code is logged in, regardless of runtime selection", async () => {
    hoisted.loggedIn = true;
    hoisted.runtimeSelection = null;
    expect(await canBrainEngineRunNow()).toBe(true);
  });

  it("REGRESSION (2026-07-22): is true when NOT logged in but a valid runtime override (e.g. Aliyun) is configured — previously this silently disabled the entire periodic backstop", async () => {
    hoisted.loggedIn = false;
    hoisted.runtimeSelection = { kind: "runtime" };
    expect(await canBrainEngineRunNow()).toBe(true);
  });

  it("is false when not logged in and no runtime override is configured", async () => {
    hoisted.loggedIn = false;
    hoisted.runtimeSelection = null;
    expect(await canBrainEngineRunNow()).toBe(false);
  });

  it("is false when not logged in and the saved runtime override is unresolved (deleted row / wrong kind)", async () => {
    hoisted.loggedIn = false;
    hoisted.runtimeSelection = { kind: "runtime-unresolved" };
    expect(await canBrainEngineRunNow()).toBe(false);
  });
});

describe("setMonitorIntervalSec", () => {
  beforeEach(() => {
    hoisted.updates.length = 0;
  });

  it("writes the new monitorIntervalSec for the given thread", async () => {
    await setMonitorIntervalSec("thread-1", "local@localhost", 300);
    expect(hoisted.updates).toHaveLength(1);
    expect(hoisted.updates[0].set.monitorIntervalSec).toBe(300);
    expect(hoisted.updates[0].set.updatedAt).toBeInstanceOf(Date);
  });

  it("accepts 0 (disables the timer — event-only wakes)", async () => {
    await setMonitorIntervalSec("thread-1", "local@localhost", 0);
    expect(hoisted.updates[0].set.monitorIntervalSec).toBe(0);
  });
});
