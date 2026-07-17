// S9 Brain console "能力降级" red card (04 §6/§7, SDLC-049) — unit tests for
// getBrainHarnessStatus / getDegradedThreadIds.
//
// Mirrors brain-session.spec.ts's mocking approach (mock the two modules
// evaluateBrainHarness reaches — register-runtime.js + the agent-harness
// registry — rather than mocking brain-session.ts itself, so the REAL
// evaluateBrainHarness logic runs against controlled inputs) plus
// writeback-telemetry.spec.ts's row-fetch-then-reduce db mock (select/from/
// where/orderBy/limit returning canned rows).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../register-runtime.js", () => ({
  registerOrchestratorRuntime: vi.fn(),
}));

const harnessMocks = vi.hoisted(() => ({
  getAgentHarnessEntry: vi.fn(),
  isAgentHarnessPackageInstalled: vi.fn(),
}));

vi.mock("@agent-native/core/agent/harness", () => ({
  ensureAgentHarnessSessionTables: vi.fn(),
  getAgentHarnessEntry: harnessMocks.getAgentHarnessEntry,
  getLatestAgentHarnessSessionForThread: vi.fn(),
  isAgentHarnessPackageInstalled: harnessMocks.isAgentHarnessPackageInstalled,
  resolveAgentHarness: vi.fn(),
  saveAgentHarnessSession: vi.fn(),
  updateAgentHarnessSession: vi.fn(),
  markAgentHarnessSessionStopped: vi.fn(),
}));

interface MockEventRow {
  id: string;
  payload: Record<string, unknown>;
  ts: Date;
}

const hoisted = vi.hoisted(() => {
  const events: MockEventRow[] = [];
  return { events };
});

vi.mock("../db/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/index.js")>();
  function isEventsTable(table: unknown): boolean {
    return (
      table !== null &&
      typeof table === "object" &&
      "seqNum" in (table as object)
    );
  }
  return {
    ...actual,
    getV3Db: vi.fn(() => ({
      select: () => ({
        from: (table: unknown) => ({
          where: (_filter: unknown) => ({
            orderBy: (_order: unknown) => ({
              limit: (n: number) =>
                isEventsTable(table) ? hoisted.events.slice(0, n) : [],
            }),
            limit: (n: number) =>
              isEventsTable(table) ? hoisted.events.slice(0, n) : [],
          }),
        }),
      }),
    })),
  };
});

import {
  getBrainHarnessStatus,
  getDegradedThreadIds,
} from "./harness-status.js";

function makeEvent(overrides: Partial<MockEventRow> = {}): MockEventRow {
  return {
    id: "ev-1",
    payload: { reason: "packages not installed", threadId: "thread-1" },
    ts: new Date(),
    ...overrides,
  };
}

describe("getBrainHarnessStatus", () => {
  const OLD_ENV = process.env.ORCH_BRAIN_HARNESS;

  beforeEach(() => {
    hoisted.events.length = 0;
    harnessMocks.getAgentHarnessEntry.mockReset();
    harnessMocks.isAgentHarnessPackageInstalled.mockReset();
  });

  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.ORCH_BRAIN_HARNESS;
    else process.env.ORCH_BRAIN_HARNESS = OLD_ENV;
  });

  it("flag unset: not requested, not degraded, regardless of event history", async () => {
    delete process.env.ORCH_BRAIN_HARNESS;
    const result = await getBrainHarnessStatus("local@localhost");
    expect(result.harnessRequested).toBe(false);
    expect(result.enabled).toBe(false);
    expect(result.degradedReason).toBeNull();
  });

  it("flag on + harness usable: enabled, NOT degraded (no red card)", async () => {
    process.env.ORCH_BRAIN_HARNESS = "1";
    harnessMocks.getAgentHarnessEntry.mockReturnValue({
      name: "acp:claude-code",
    });
    harnessMocks.isAgentHarnessPackageInstalled.mockReturnValue(true);
    const result = await getBrainHarnessStatus("local@localhost");
    expect(result.harnessRequested).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.degradedReason).toBeNull();
  });

  it("flag on + packages missing: LIVE degradation with a real reason (SDLC-049)", async () => {
    process.env.ORCH_BRAIN_HARNESS = "1";
    harnessMocks.getAgentHarnessEntry.mockReturnValue({
      name: "acp:claude-code",
    });
    harnessMocks.isAgentHarnessPackageInstalled.mockReturnValue(false);
    const result = await getBrainHarnessStatus("local@localhost");
    expect(result.enabled).toBe(false);
    expect(result.degradedReason).toMatch(/not installed\/resolvable/);
  });

  it("surfaces the most recent capability.degraded event + total count", async () => {
    hoisted.events.push(
      makeEvent({ id: "ev-1", ts: new Date("2026-01-01T00:00:00Z") }),
      makeEvent({
        id: "ev-2",
        ts: new Date("2026-01-02T00:00:00Z"),
        payload: { reason: "harness init threw: boom", threadId: "thread-2" },
      }),
    );
    const result = await getBrainHarnessStatus("local@localhost");
    expect(result.eventCount).toBe(2);
    // The mock's canned order already puts ev-1 first — this test only
    // verifies the module reads back whatever row .orderBy(desc(ts)) put
    // first, not that it re-sorts client-side.
    expect(result.lastEvent?.reason).toBe("packages not installed");
  });

  it("DB read failure degrades to 'no historical event' rather than throwing", async () => {
    const { getV3Db } = await import("../db/index.js");
    (getV3Db as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => {
        throw new Error("db unreachable");
      },
    );
    const result = await getBrainHarnessStatus("local@localhost");
    expect(result.lastEvent).toBeNull();
    expect(result.eventCount).toBe(0);
  });
});

describe("getDegradedThreadIds", () => {
  beforeEach(() => {
    hoisted.events.length = 0;
  });

  it("empty when no capability.degraded events exist", async () => {
    const ids = await getDegradedThreadIds("local@localhost");
    expect(ids.size).toBe(0);
  });

  it("collects distinct threadIds from event payloads (rail badge source)", async () => {
    hoisted.events.push(
      makeEvent({ id: "ev-1", payload: { threadId: "thread-1" } }),
      makeEvent({ id: "ev-2", payload: { threadId: "thread-2" } }),
      makeEvent({ id: "ev-3", payload: { threadId: "thread-1" } }),
    );
    const ids = await getDegradedThreadIds("local@localhost");
    expect(ids.size).toBe(2);
    expect(ids.has("thread-1")).toBe(true);
    expect(ids.has("thread-2")).toBe(true);
  });
});
