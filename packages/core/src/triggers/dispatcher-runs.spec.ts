/**
 * routine_runs engine hook on the EVENT path (§1.5.9 / §1.5.19 negative cases).
 *
 * The store-level helpers are unit-tested in `routine-runs/store.spec.ts`; this
 * spec verifies the OTHER half of the contract — that the dispatcher actually
 * invokes those hooks around a real dispatch, lands exactly one row per run,
 * and reaches a terminal state even when the executed body throws:
 *
 *   - success: one `insertRoutineRun({status:"running"})` then one
 *     `finishRoutineRun({status:"success"})` — never two running rows, never a
 *     row left in `running`.
 *   - error (the swallowed-throw case): when `runAgentLoop` rejects, the
 *     dispatcher's catch still calls `finishRoutineRun({status:"error"})` with a
 *     non-empty `error`, does NOT insert a second row, and does NOT rethrow
 *     (the event handler resolves, so the bus is never left in a bad state).
 *   - attribution: two separate routines firing back-to-back each get their own
 *     row with the right routineName/owner/threadId — the rows never cross.
 *     (Same-routine concurrent writes — manual run racing a tick — are asserted
 *     at the store level in `routine-runs/store.spec.ts`, which has no dispatcher
 *     user-validation race to interleave with.)
 *
 * `routine-runs/store.js` is mocked so we observe the hook calls directly; the
 * rest of the mock surface mirrors `dispatcher.spec.ts` (the real engine deps
 * are stubbed so no model call / DB write happens).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { initTriggerDispatcher } from "./dispatcher.js";

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
  evaluateCondition: vi.fn(async () => true),
}));

vi.mock("../routine-runs/store.js", () => ({
  insertRoutineRun: insertRoutineRunMock,
  finishRoutineRun: finishRoutineRunMock,
}));

vi.mock(import("../db/client.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getDbExec: getDbExecMock };
});

const OWNER = "alice+triggers@agent-native.test";
const EVENT_META = {
  owner: OWNER,
  eventId: "event-1",
  emittedAt: "2026-04-30T00:00:00.000Z",
};

function eventJob(opts: { name: string; event: string }) {
  return {
    id: `resource-${opts.name}`,
    owner: OWNER,
    path: `jobs/${opts.name}.md`,
    content: `---
schedule: ""
enabled: true
triggerType: event
event: ${opts.event}
mode: agentic
createdBy: ${OWNER}
---

Respond to the event.`,
  };
}

/**
 * Subscribe + return the handler the dispatcher registered for `eventName`.
 *
 * `subscribeMock` is NOT cleared between init calls within a test, and the
 * dispatcher's module-level `_eventSubscriptions` persists across this file, so
 * each test uses a UNIQUE event name (mirroring `dispatcher.spec.ts`, which
 * pairs `test.event.fired` with `qa.event.prompt`) to guarantee a fresh
 * `subscribe` call we can capture.
 */
async function handlerFor(
  eventName: string,
): Promise<(payload: unknown, meta: typeof EVENT_META) => Promise<void>> {
  await initTriggerDispatcher({
    getActions: () => ({}),
    getSystemPrompt: async () => "system",
    model: "test-model",
  });
  const entry = subscribeMock.mock.calls.find(([name]) => name === eventName);
  if (!entry) throw new Error(`no handler subscribed for ${eventName}`);
  return entry[1];
}

describe("dispatcher → routine_runs hook (event path)", () => {
  let nextId = 0;

  beforeEach(() => {
    vi.clearAllMocks();
    nextId = 0;
    // Always report the run-as user as a valid, existing org member so
    // `isTriggerRunAsStillValid` passes for every dispatch (mockImplementation,
    // not mockResolvedValue, so it survives clearAllMocks and answers every
    // validation query identically across concurrent dispatches).
    dbExecuteMock.mockImplementation(async () => ({ rows: [{ "1": 1 }] }));
    getDbExecMock.mockReturnValue({ execute: dbExecuteMock });
    resourcePutMock.mockResolvedValue(undefined);
    createThreadMock.mockResolvedValue({ id: "thread-1" });
    subscribeMock.mockImplementation((eventName: string) => `sub-${eventName}`);
    runAgentLoopMock.mockResolvedValue(undefined);
    // Hand out a fresh id per insert so concurrency rows are distinguishable.
    insertRoutineRunMock.mockImplementation(async () => `run-${++nextId}`);
    finishRoutineRunMock.mockResolvedValue(undefined);
  });

  it("records exactly one running row, then finishes it success", async () => {
    resourceListAllOwnersMock.mockResolvedValue([
      eventJob({ name: "inbox-alert", event: "test.event.fired" }),
    ]);

    const handler = await handlerFor("test.event.fired");
    await handler({ ok: true }, EVENT_META);

    // Exactly one running row inserted, with the event-path shape.
    expect(insertRoutineRunMock).toHaveBeenCalledTimes(1);
    expect(insertRoutineRunMock.mock.calls[0][0]).toMatchObject({
      ownerEmail: OWNER,
      routineName: "inbox-alert",
      kind: "event",
      trigger: "test.event.fired",
      threadId: "thread-1",
      status: "running",
    });
    expect(typeof insertRoutineRunMock.mock.calls[0][0].startedAt).toBe(
      "number",
    );

    // Exactly one terminal write, success, against the same row id.
    expect(finishRoutineRunMock).toHaveBeenCalledTimes(1);
    expect(finishRoutineRunMock).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ status: "success" }),
    );
    expect(typeof finishRoutineRunMock.mock.calls[0][1].finishedAt).toBe(
      "number",
    );
  });

  it("error path: a thrown body is swallowed but still finishes the row as error (no running left, no rethrow)", async () => {
    resourceListAllOwnersMock.mockResolvedValue([
      eventJob({ name: "flaky-alert", event: "flaky.event.fired" }),
    ]);
    runAgentLoopMock.mockRejectedValue(new Error("agent blew up"));

    const handler = await handlerFor("flaky.event.fired");

    // The handler must NOT reject — the dispatcher's catch swallows the error.
    await expect(handler({ ok: true }, EVENT_META)).resolves.toBeUndefined();

    // Still exactly one row inserted (running), and it is finished as error
    // with a non-empty message — never left dangling in `running`.
    expect(insertRoutineRunMock).toHaveBeenCalledTimes(1);
    expect(finishRoutineRunMock).toHaveBeenCalledTimes(1);
    const [finishedId, patch] = finishRoutineRunMock.mock.calls[0];
    expect(finishedId).toBe("run-1");
    expect(patch.status).toBe("error");
    expect(patch.error).toBeTruthy();
    expect(patch.error).toContain("agent blew up");

    // The success branch was never taken: no second terminal write.
    const successCalls = finishRoutineRunMock.mock.calls.filter(
      ([, p]) => p.status === "success",
    );
    expect(successCalls).toHaveLength(0);
  });

  it("two routines firing back-to-back write two non-crossing rows", async () => {
    resourceListAllOwnersMock.mockResolvedValue([
      eventJob({ name: "alpha", event: "alpha.fired" }),
      eventJob({ name: "beta", event: "beta.fired" }),
    ]);
    // Distinct threads (keyed by routine name) so we can prove the rows don't
    // cross regardless of which run's createThread resolves first.
    createThreadMock.mockImplementation(
      async (_owner: string, opts: { title: string }) =>
        opts.title.includes("alpha")
          ? { id: "thread-alpha" }
          : { id: "thread-beta" },
    );

    // A single init subscribes both events; capture each handler by name.
    await initTriggerDispatcher({
      getActions: () => ({}),
      getSystemPrompt: async () => "system",
      model: "test-model",
    });
    const alphaEntry = subscribeMock.mock.calls.find(
      ([name]) => name === "alpha.fired",
    );
    const betaEntry = subscribeMock.mock.calls.find(
      ([name]) => name === "beta.fired",
    );
    if (!alphaEntry || !betaEntry) {
      throw new Error("expected both alpha + beta handlers to be subscribed");
    }
    const alpha = alphaEntry[1];
    const beta = betaEntry[1];

    // Fire both, in flight together.
    await alpha({ which: "a" }, EVENT_META);
    await beta({ which: "b" }, EVENT_META);

    expect(insertRoutineRunMock).toHaveBeenCalledTimes(2);
    const byName = Object.fromEntries(
      insertRoutineRunMock.mock.calls.map(([row]) => [row.routineName, row]),
    );

    expect(byName.alpha).toMatchObject({
      routineName: "alpha",
      trigger: "alpha.fired",
      threadId: "thread-alpha",
      ownerEmail: OWNER,
      kind: "event",
    });
    expect(byName.beta).toMatchObject({
      routineName: "beta",
      trigger: "beta.fired",
      threadId: "thread-beta",
      ownerEmail: OWNER,
      kind: "event",
    });

    // Two separate rows finished (one each), not one row reused.
    expect(finishRoutineRunMock).toHaveBeenCalledTimes(2);
    const finishedIds = finishRoutineRunMock.mock.calls.map(([id]) => id);
    expect(new Set(finishedIds).size).toBe(2);
  });
});
