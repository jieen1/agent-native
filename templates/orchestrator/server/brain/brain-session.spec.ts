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
  recordRuntimeOverrideDegradation,
  resolveBrainEngineChoice,
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
    const outcome = makeOutcome({
      resultSubtype: "success",
      sawAssistantText: false,
    });

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
      throw new Error(
        "Cannot find module '@agentclientprotocol/claude-agent-acp'",
      );
    });
    const result = evaluateBrainHarness();
    expect(result.enabled).toBe(false);
    expect(result.degradedReason).toMatch(/harness init threw/);
    expect(result.degradedReason).toMatch(/claude-agent-acp/);
  });

  it("flag=1 but packages not installed -> degraded", () => {
    process.env[BRAIN_HARNESS_ENV] = "1";
    harnessMocks.getAgentHarnessEntry.mockReturnValue({
      name: "acp:claude-code",
    });
    harnessMocks.isAgentHarnessPackageInstalled.mockReturnValue(false);
    const result = evaluateBrainHarness();
    expect(result.enabled).toBe(false);
    expect(result.degradedReason).toMatch(/not installed/);
  });

  it("flag=1 and harness resolvable -> enabled, not degraded", () => {
    process.env[BRAIN_HARNESS_ENV] = "1";
    harnessMocks.getAgentHarnessEntry.mockReturnValue({
      name: "acp:claude-code",
    });
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

// ── Brain runtime-switching (additive feature) ──────────────────────────────
//
// resolveBrainEngineChoice is startBrainTurn's new branch point, extracted as
// a pure function (mirrors evaluateBrainHarness's "pure decision, tested
// separately from its IO plumbing" shape) specifically so this decision is
// unit-testable without standing up startBrainTurn's full DB/fs/child-process
// surface. It is the ONLY place `useSdkBrain`/`runtimeOverride` are computed;
// startBrainTurn just destructures its result and threads runtimeOverride's
// fields into runSdkBrainTurn verbatim (a trivial 1:1 field mapping), so
// testing this function fully covers "the right override reaches
// runSdkBrainTurn regardless of login state" and "an unresolved override
// falls through to the pre-existing !loggedIn behavior".

describe("resolveBrainEngineChoice — startBrainTurn's engine-choice branch point", () => {
  const runtimeSelection = {
    kind: "runtime" as const,
    runtimeConfigId: "rt_4ry56fwd1yj763f3",
    name: "Aliyun Bailian",
    baseUrl:
      "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.8-max-preview",
    apiKey: "sk-real-aliyun-key",
  };

  it("a resolved runtime selection forces useSdkBrain=true even when Claude Code IS logged in", () => {
    const result = resolveBrainEngineChoice(
      runtimeSelection,
      /* loggedIn */ true,
    );
    expect(result.useSdkBrain).toBe(true);
    expect(result.runtimeOverride).toEqual(runtimeSelection);
  });

  it("a resolved runtime selection forces useSdkBrain=true when Claude Code is NOT logged in too", () => {
    const result = resolveBrainEngineChoice(runtimeSelection, false);
    expect(result.useSdkBrain).toBe(true);
    expect(result.runtimeOverride).toEqual(runtimeSelection);
  });

  it("the 'claude' variant preserves the EXACT pre-existing !loggedIn behavior — logged in", () => {
    const result = resolveBrainEngineChoice(
      { kind: "claude", model: "claude-sonnet-5[1m]" },
      true,
    );
    expect(result.useSdkBrain).toBe(false);
    expect(result.runtimeOverride).toBeNull();
  });

  it("the 'claude' variant preserves the EXACT pre-existing !loggedIn behavior — logged out", () => {
    const result = resolveBrainEngineChoice(
      { kind: "claude", model: "claude-sonnet-5[1m]" },
      false,
    );
    expect(result.useSdkBrain).toBe(true);
    expect(result.runtimeOverride).toBeNull();
  });

  it("'runtime-unresolved' falls through to the pre-existing !loggedIn behavior — logged in -> CC path, not blocked", () => {
    const result = resolveBrainEngineChoice(
      { kind: "runtime-unresolved", runtimeConfigId: "rt_deleted" },
      true,
    );
    expect(result.useSdkBrain).toBe(false);
    expect(result.runtimeOverride).toBeNull();
  });

  it("'runtime-unresolved' falls through to the pre-existing !loggedIn behavior — logged out -> sdk brain fallback, not blocked", () => {
    const result = resolveBrainEngineChoice(
      { kind: "runtime-unresolved", runtimeConfigId: "rt_deleted" },
      false,
    );
    expect(result.useSdkBrain).toBe(true);
    expect(result.runtimeOverride).toBeNull();
  });
});

describe("recordRuntimeOverrideDegradation — a broken saved selection must never fail silently", () => {
  it("logs at error level AND writes a capability.degraded v3_event naming the runtime config id", async () => {
    const { db, inserted } = createMockThreadsDb();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await recordRuntimeOverrideDegradation(
      db,
      "thread-99",
      "owner@example.com",
      null,
      "rt_deleted",
    );

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toMatch(/capability degraded/);
    expect(errorSpy.mock.calls[0][0]).toMatch(/runtime:rt_deleted/);

    expect(inserted).toHaveLength(1);
    expect(inserted[0].kind).toBe("capability.degraded");
    expect(inserted[0].payload).toMatchObject({
      capability: "brain-runtime-override",
      runtimeConfigId: "rt_deleted",
      threadId: "thread-99",
    });

    errorSpy.mockRestore();
  });

  it("writes a fresh event on EVERY call — no dedup", async () => {
    const { db, inserted } = createMockThreadsDb();
    vi.spyOn(console, "error").mockImplementation(() => {});

    await recordRuntimeOverrideDegradation(db, "t1", "o@x.com", null, "rt_x");
    await recordRuntimeOverrideDegradation(db, "t1", "o@x.com", null, "rt_x");

    expect(inserted).toHaveLength(2);

    vi.restoreAllMocks();
  });
});
