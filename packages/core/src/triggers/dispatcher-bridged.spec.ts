/**
 * Cross-process bridged-event dispatch (Phase A3 §1.5.23 / §1.5.24).
 *
 * `bridge.spec.ts` proves the POLLER (pull → cursor → call `dispatch`) in
 * isolation with a mocked dispatch seam. This spec proves the OTHER half: that
 * `dispatchBridgedEvent` — the function the poller actually calls per event —
 * runs the SAME matching + condition + agentic + `routine_runs` path as the
 * same-process handler, but gated on `sourceApp`. It closes the Phase A3
 * acceptance gaps that the poller test mocks away:
 *
 *   - acceptance #1: a bridged `plan.created` (sourceApp=plan) whose condition
 *     is satisfied executes and lands exactly one `routine_runs` row
 *     (running → success). All seams mocked — no real sibling app / OAuth / LLM
 *     (§1.5.24).
 *   - acceptance #5: the condition is evaluated against the REAL event payload;
 *     when it is NOT satisfied the routine is skipped — no dispatch, no
 *     `routine_runs` row.
 *   - sourceApp isolation: a bridged event matches ONLY triggers whose
 *     `sourceApp` equals the emitting app. A same-process trigger (no sourceApp)
 *     is never fired by the bridge, and a cross-app trigger is never fired by a
 *     same-process event.
 *   - owner scope: a bridged event for owner A must not fire owner B's routine.
 *
 * Mock surface mirrors `dispatcher-runs.spec.ts` (real engine deps stubbed so no
 * model call / DB write happens); `routine-runs/store.js` is mocked so the
 * landing of the history row is observable directly.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchBridgedEvent, initTriggerDispatcher } from "./dispatcher.js";

const resourceListAllOwnersMock = vi.hoisted(() => vi.fn());
const resourcePutMock = vi.hoisted(() => vi.fn());
const createThreadMock = vi.hoisted(() => vi.fn());
const subscribeMock = vi.hoisted(() => vi.fn());
const unsubscribeMock = vi.hoisted(() => vi.fn());
const runAgentLoopMock = vi.hoisted(() => vi.fn());
const dbExecuteMock = vi.hoisted(() => vi.fn());
const getDbExecMock = vi.hoisted(() => vi.fn());
const insertRoutineRunMock = vi.hoisted(() => vi.fn());
const finishRoutineRunMock = vi.hoisted(() => vi.fn());
const evaluateConditionMock = vi.hoisted(() => vi.fn());

vi.mock("../resources/store.js", () => ({
  resourceListAllOwners: resourceListAllOwnersMock,
  resourcePut: resourcePutMock,
}));

vi.mock("../event-bus/index.js", () => ({
  subscribe: subscribeMock,
  unsubscribe: unsubscribeMock,
}));

vi.mock("../chat-threads/store.js", () => ({
  createThread: createThreadMock,
}));

vi.mock("../agent/production-agent.js", () => ({
  actionsToEngineTools: vi.fn(() => []),
  getOwnerActiveApiKey: vi.fn(async () => "test-api-key"),
  runAgentLoop: runAgentLoopMock,
}));

vi.mock("../agent/engine/index.js", () => ({
  getStoredModelForEngine: vi.fn(async () => undefined),
  normalizeModelForEngine: (
    engine: { defaultModel?: string },
    model?: string | null,
  ) => model ?? engine.defaultModel,
  resolveEngine: vi.fn(async () => ({
    name: "test-engine",
    defaultModel: "test-model",
  })),
}));

vi.mock("./condition-evaluator.js", () => ({
  evaluateCondition: evaluateConditionMock,
}));

vi.mock("../routine-runs/store.js", () => ({
  insertRoutineRun: insertRoutineRunMock,
  finishRoutineRun: finishRoutineRunMock,
}));

vi.mock(import("../db/client.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getDbExec: getDbExecMock };
});

const OWNER = "alice+bridge@agent-native.test";

/** EventMeta as the bridge poller constructs it (eventId `${sourceApp}:${seq}`). */
function bridgeMeta(seq: number, owner = OWNER) {
  return {
    owner,
    eventId: `plan:${seq}`,
    emittedAt: "2026-04-30T00:00:00.000Z",
  };
}

/** A `jobs/*.md` event routine, optionally cross-app (with `sourceApp`). */
function eventJob(opts: {
  name: string;
  event: string;
  sourceApp?: string;
  condition?: string;
  owner?: string;
}) {
  const owner = opts.owner ?? OWNER;
  const lines = [
    "---",
    'schedule: ""',
    "enabled: true",
    "triggerType: event",
    `event: ${opts.event}`,
  ];
  if (opts.sourceApp) lines.push(`sourceApp: ${opts.sourceApp}`);
  if (opts.condition) lines.push(`condition: "${opts.condition}"`);
  lines.push(
    "mode: agentic",
    `createdBy: ${owner}`,
    "---",
    "",
    "Do the thing.",
  );
  return {
    id: `resource-${opts.name}`,
    owner,
    path: `jobs/${opts.name}.md`,
    content: lines.join("\n"),
  };
}

describe("dispatchBridgedEvent (cross-process event path)", () => {
  let nextId = 0;

  beforeEach(async () => {
    vi.clearAllMocks();
    nextId = 0;
    dbExecuteMock.mockImplementation(async () => ({ rows: [{ "1": 1 }] }));
    getDbExecMock.mockReturnValue({ execute: dbExecuteMock });
    resourcePutMock.mockResolvedValue(undefined);
    createThreadMock.mockResolvedValue({ id: "thread-1" });
    subscribeMock.mockImplementation((eventName: string) => `sub-${eventName}`);
    runAgentLoopMock.mockResolvedValue(undefined);
    insertRoutineRunMock.mockImplementation(async () => `run-${++nextId}`);
    finishRoutineRunMock.mockResolvedValue(undefined);
    evaluateConditionMock.mockResolvedValue(true);
    // The dispatcher only acts when `_deps` is set (init once). Use a benign
    // event name so init's own subscribe pass doesn't matter for these tests.
    resourceListAllOwnersMock.mockResolvedValue([]);
    await initTriggerDispatcher({
      getActions: () => ({}),
      getSystemPrompt: async () => "system",
      model: "test-model",
    });
  });

  it("acceptance #1: a satisfied cross-app event executes and lands one routine_runs row (running→success)", async () => {
    resourceListAllOwnersMock.mockResolvedValue([
      eventJob({
        name: "plan-watch",
        event: "plan.created",
        sourceApp: "plan",
      }),
    ]);

    await dispatchBridgedEvent(
      "plan.created",
      { planId: "p1", title: "Q3 launch" },
      bridgeMeta(7),
      "plan",
    );

    // The agent loop actually ran (execution happened).
    expect(runAgentLoopMock).toHaveBeenCalledTimes(1);

    // Exactly one running row was inserted with the event-path shape.
    expect(insertRoutineRunMock).toHaveBeenCalledTimes(1);
    expect(insertRoutineRunMock.mock.calls[0][0]).toMatchObject({
      ownerEmail: OWNER,
      routineName: "plan-watch",
      kind: "event",
      trigger: "plan.created",
      threadId: "thread-1",
      status: "running",
    });
    // And it was finished success against the same id — never left running.
    expect(finishRoutineRunMock).toHaveBeenCalledTimes(1);
    expect(finishRoutineRunMock).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ status: "success" }),
    );
  });

  it("acceptance #5: the condition is evaluated against the real payload, and execution happens only when satisfied", async () => {
    resourceListAllOwnersMock.mockResolvedValue([
      eventJob({
        name: "big-plan-only",
        event: "plan.created",
        sourceApp: "plan",
        condition: "the plan title contains launch",
      }),
    ]);
    const payload = { planId: "p1", title: "Q3 launch" };

    await dispatchBridgedEvent("plan.created", payload, bridgeMeta(7), "plan");

    // evaluateCondition saw the routine's condition AND the real event payload.
    expect(evaluateConditionMock).toHaveBeenCalledTimes(1);
    expect(evaluateConditionMock.mock.calls[0][0]).toBe(
      "the plan title contains launch",
    );
    expect(evaluateConditionMock.mock.calls[0][1]).toEqual(payload);
    // Satisfied → executed + landed a row.
    expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
    expect(insertRoutineRunMock).toHaveBeenCalledTimes(1);
  });

  it("acceptance #5 (negative): an unsatisfied condition skips — no dispatch, no routine_runs row", async () => {
    resourceListAllOwnersMock.mockResolvedValue([
      eventJob({
        name: "big-plan-only",
        event: "plan.created",
        sourceApp: "plan",
        condition: "the plan title contains launch",
      }),
    ]);
    evaluateConditionMock.mockResolvedValue(false);

    await dispatchBridgedEvent(
      "plan.created",
      { planId: "p1", title: "minor edit" },
      bridgeMeta(7),
      "plan",
    );

    expect(evaluateConditionMock).toHaveBeenCalledTimes(1);
    // Condition not met → nothing runs and nothing is recorded.
    expect(runAgentLoopMock).not.toHaveBeenCalled();
    expect(insertRoutineRunMock).not.toHaveBeenCalled();
    expect(finishRoutineRunMock).not.toHaveBeenCalled();
  });

  it("sourceApp isolation: a same-process trigger (no sourceApp) is NOT fired by a bridged event", async () => {
    resourceListAllOwnersMock.mockResolvedValue([
      // Same event name, but no sourceApp → belongs to the in-process handler.
      eventJob({ name: "self-watch", event: "plan.created" }),
    ]);

    await dispatchBridgedEvent("plan.created", {}, bridgeMeta(7), "plan");

    expect(runAgentLoopMock).not.toHaveBeenCalled();
    expect(insertRoutineRunMock).not.toHaveBeenCalled();
  });

  it("sourceApp isolation: a bridged event only fires triggers whose sourceApp matches the emitting app", async () => {
    resourceListAllOwnersMock.mockResolvedValue([
      eventJob({
        name: "from-plan",
        event: "plan.created",
        sourceApp: "plan",
      }),
      eventJob({
        name: "from-mail",
        event: "plan.created",
        sourceApp: "mail",
      }),
    ]);

    await dispatchBridgedEvent("plan.created", {}, bridgeMeta(7), "plan");

    // Only the plan-sourced routine ran.
    expect(insertRoutineRunMock).toHaveBeenCalledTimes(1);
    expect(insertRoutineRunMock.mock.calls[0][0]).toMatchObject({
      routineName: "from-plan",
    });
  });

  it("owner scope: a bridged event for owner A does not fire owner B's routine", async () => {
    resourceListAllOwnersMock.mockResolvedValue([
      eventJob({
        name: "bob-plan",
        event: "plan.created",
        sourceApp: "plan",
        owner: "bob@agent-native.test",
      }),
    ]);

    await dispatchBridgedEvent(
      "plan.created",
      {},
      bridgeMeta(7, OWNER), // event owned by alice
      "plan",
    );

    expect(runAgentLoopMock).not.toHaveBeenCalled();
    expect(insertRoutineRunMock).not.toHaveBeenCalled();
  });
});
