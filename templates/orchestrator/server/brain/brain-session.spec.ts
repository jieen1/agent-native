// F7 unit tests for brain-session.ts's two SDLC-fix contracts:
//   T-F7-07 — turn terminal-state contract (04 §6, SDLC-060): a same-turn
//     closing race (`result.subtype === "error_during_execution"` landing
//     AFTER a delivered assistant summary) must not overwrite the thread to
//     `error`.
//   T-F7-08 — harness degradation must never be silent (04 §7, SDLC-049):
//     ORCH_BRAIN_HARNESS=1 but the ACP harness unusable must console.error +
//     write a `capability.degraded` v3_event every time, not just fall back
//     quietly to raw-spawn.
//
// All DB calls are mocked; no network/process spawn happens in this file.

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

import {
  evaluateBrainHarness,
  recordHarnessDegradation,
  finalizeThreadStatus,
  BRAIN_HARNESS_ENV,
  type BrainRunOutcome,
} from "./brain-session.js";

// ── Mock DB builder (mirrors v3-dispatcher.spec.ts's createMockDb shape) ────

function createMockThreadsDb() {
  const updates: Array<{ set: Record<string, unknown>; where: unknown }> = [];
  const inserted: Array<Record<string, unknown>> = [];
  const db = {
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: async (where: unknown) => {
          updates.push({ set, where });
          return {};
        },
      }),
    }),
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        inserted.push(row);
        return {};
      },
    }),
  };
  return { db: db as any, updates, inserted };
}

function makeOutcome(overrides: Partial<BrainRunOutcome>): BrainRunOutcome {
  return {
    resumeNotFound: false,
    resultSubtype: null,
    sawResult: true,
    exitCode: 0,
    stderr: "",
    sawAssistantText: false,
    lastResultText: null,
    ...overrides,
  };
}

// ── T-F7-07: turn terminal-state contract ───────────────────────────────────

describe("finalizeThreadStatus — turn terminal-state contract (T-F7-07)", () => {
  it("delivered summary + error_during_execution race -> done + closingAnomaly (SDLC-060)", async () => {
    const { db, updates } = createMockThreadsDb();
    const outcome = makeOutcome({
      resultSubtype: "error_during_execution",
      sawAssistantText: true,
      lastResultText: "error_during_execution: opaque failure",
    });

    await finalizeThreadStatus(db, "thread-1", outcome);

    expect(updates).toHaveLength(1);
    expect(updates[0].set.status).toBe("done");
    expect(updates[0].set.closingAnomaly).toBe(
      "error_during_execution: opaque failure",
    );
  });

  it("no delivered summary + error_during_execution -> error (no false all-clear)", async () => {
    const { db, updates } = createMockThreadsDb();
    const outcome = makeOutcome({
      resultSubtype: "error_during_execution",
      sawAssistantText: false,
      lastResultText: null,
    });

    await finalizeThreadStatus(db, "thread-2", outcome);

    expect(updates).toHaveLength(1);
    expect(updates[0].set.status).toBe("error");
    expect(updates[0].set.closingAnomaly).toBeUndefined();
  });

  it("success subtype -> done regardless of sawAssistantText", async () => {
    const { db, updates } = createMockThreadsDb();
    const outcome = makeOutcome({ resultSubtype: "success", sawAssistantText: false });

    await finalizeThreadStatus(db, "thread-3", outcome);

    expect(updates[0].set.status).toBe("done");
  });
});

// ── T-F7-08: harness degradation must never be silent ───────────────────────

describe("evaluateBrainHarness — capability-degradation detection (T-F7-08)", () => {
  const originalEnv = process.env[BRAIN_HARNESS_ENV];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[BRAIN_HARNESS_ENV];
    else process.env[BRAIN_HARNESS_ENV] = originalEnv;
  });

  it("flag unset -> not enabled, NOT degraded (nothing was requested)", () => {
    delete process.env[BRAIN_HARNESS_ENV];
    const result = evaluateBrainHarness();
    expect(result.enabled).toBe(false);
    expect(result.degradedReason).toBeNull();
  });

  it("flag=1 but ACP import/init throws -> degraded with a reason (mock ACP import error)", () => {
    process.env[BRAIN_HARNESS_ENV] = "1";
    harnessMocks.getAgentHarnessEntry.mockImplementation(() => {
      throw new Error("Cannot find module '@agentclientprotocol/claude-agent-acp'");
    });
    const result = evaluateBrainHarness();
    expect(result.enabled).toBe(false);
    expect(result.degradedReason).toMatch(/harness init threw/);
    expect(result.degradedReason).toMatch(/claude-agent-acp/);
  });

  it("flag=1 but packages not installed -> degraded", () => {
    process.env[BRAIN_HARNESS_ENV] = "1";
    harnessMocks.getAgentHarnessEntry.mockReturnValue({ name: "acp:claude-code" });
    harnessMocks.isAgentHarnessPackageInstalled.mockReturnValue(false);
    const result = evaluateBrainHarness();
    expect(result.enabled).toBe(false);
    expect(result.degradedReason).toMatch(/not installed/);
  });

  it("flag=1 and harness resolvable -> enabled, not degraded", () => {
    process.env[BRAIN_HARNESS_ENV] = "1";
    harnessMocks.getAgentHarnessEntry.mockReturnValue({ name: "acp:claude-code" });
    harnessMocks.isAgentHarnessPackageInstalled.mockReturnValue(true);
    const result = evaluateBrainHarness();
    expect(result.enabled).toBe(true);
    expect(result.degradedReason).toBeNull();
  });
});

describe("recordHarnessDegradation (T-F7-08)", () => {
  it("logs at error level AND writes a capability.degraded v3_event", async () => {
    const { db, inserted } = createMockThreadsDb();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await recordHarnessDegradation(
      db,
      "thread-42",
      "owner@example.com",
      null,
      "harness packages are not installed/resolvable",
    );

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toMatch(/capability degraded/);
    expect(errorSpy.mock.calls[0][0]).toMatch(/thread-42/);

    expect(inserted).toHaveLength(1);
    expect(inserted[0].kind).toBe("capability.degraded");
    expect(inserted[0].payload).toMatchObject({
      capability: "brain-harness",
      threadId: "thread-42",
    });

    errorSpy.mockRestore();
  });

  it("writes a fresh event on EVERY call — no dedup (stays visible while degraded persists)", async () => {
    const { db, inserted } = createMockThreadsDb();
    vi.spyOn(console, "error").mockImplementation(() => {});

    await recordHarnessDegradation(db, "thread-1", "o@x.com", null, "reason A");
    await recordHarnessDegradation(db, "thread-1", "o@x.com", null, "reason A");

    expect(inserted).toHaveLength(2);

    vi.restoreAllMocks();
  });
});
