// S9 Brain console "监控节奏" card's inline edit (04 §6) — unit test for
// setMonitorIntervalSec. Only this function is covered here; monitorSweepOnce
// / stampBrainWake are exercised indirectly elsewhere and pull in heavier
// dependencies (getManagedClaudeStatus, a dynamic import of brain-session.js)
// out of scope for this addition.

import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const updates: Array<{ set: Record<string, unknown>; where: unknown }> = [];
  return { updates };
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

import { setMonitorIntervalSec } from "./brain-monitor.js";

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
