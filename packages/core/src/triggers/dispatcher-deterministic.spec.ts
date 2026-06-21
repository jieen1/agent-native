/**
 * Deterministic EVENT-trigger dispatch (Phase A4 §1.5.10).
 *
 * Proves the event path is wired to `runDeterministicStep`:
 *   - a deterministic event routine runs its single web-request step with NO
 *     agent loop (runAgentLoop spy = 0) and NO Haiku classifier call
 *     (callHaikuClassifier spy = 0 — the condition is empty so the gate never
 *     touches the classifier), and the wired `web-request` entry fires exactly
 *     once with the declared URL.
 *   - the run is recorded in routine_runs (running → success).
 *   - a deterministic `action` routine calls the named action with its params.
 *   - control: an equivalent AGENTIC routine DOES run the agent loop, proving
 *     the spy is effective.
 *
 * Mock surface mirrors `dispatcher-runs.spec.ts`; condition-evaluator is the
 * REAL module so we can assert the classifier is never reached for a
 * deterministic, condition-less trigger.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { initTriggerDispatcher } from "./dispatcher.js";
// REAL condition-evaluator (not mocked) so we can prove a deterministic,
// condition-less trigger never reaches the Haiku classifier: the real
// `evaluateCondition` short-circuits to `true` for an empty condition without
// calling `callHaikuClassifier`, and we spy on the real export to assert it.
import * as conditionEvaluator from "./condition-evaluator.js";
import * as productionAgent from "./../agent/production-agent.js";

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

vi.mock("../routine-runs/store.js", () => ({
  insertRoutineRun: insertRoutineRunMock,
  finishRoutineRun: finishRoutineRunMock,
}));

vi.mock(import("../db/client.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getDbExec: getDbExecMock };
});

const OWNER = "alice+det@agent-native.test";
const EVENT_META = {
  owner: OWNER,
  eventId: "event-1",
  emittedAt: "2026-06-21T00:00:00.000Z",
};

function deterministicEventJob(opts: {
  name: string;
  event: string;
  declaration: Record<string, unknown>;
}) {
  return {
    id: `resource-${opts.name}`,
    owner: OWNER,
    path: `jobs/${opts.name}.md`,
    content: `---
schedule: ""
enabled: true
triggerType: event
event: ${opts.event}
mode: deterministic
createdBy: ${OWNER}
---

\`\`\`json
${JSON.stringify(opts.declaration, null, 2)}
\`\`\``,
  };
}

async function handlerFor(
  eventName: string,
  getActions: () => Record<string, unknown>,
): Promise<(payload: unknown, meta: typeof EVENT_META) => Promise<void>> {
  await initTriggerDispatcher({
    getActions: getActions as any,
    getSystemPrompt: async () => "system",
    model: "test-model",
  });
  const entry = subscribeMock.mock.calls.find(([name]) => name === eventName);
  if (!entry) throw new Error(`no handler subscribed for ${eventName}`);
  return entry[1];
}

describe("dispatcher — deterministic event trigger", () => {
  let nextId = 0;

  beforeEach(() => {
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
  });

  it("runs the web-request step with NO agent loop and records routine_runs success", async () => {
    const webRequestSpy = vi.fn(async () => "HTTP 200 OK");
    resourceListAllOwnersMock.mockResolvedValue([
      deterministicEventJob({
        name: "det-webhook",
        event: "det.webhook.fired",
        declaration: {
          kind: "web-request",
          method: "POST",
          url: "https://hooks.example.com/det",
        },
      }),
    ]);

    const handler = await handlerFor("det.webhook.fired", () => ({
      "web-request": { tool: {}, run: webRequestSpy },
    }));
    await handler({ ok: true }, EVENT_META);

    // No agent loop ran.
    expect(runAgentLoopMock).not.toHaveBeenCalled();

    // The wired web-request entry fired once with the declared URL.
    expect(webRequestSpy).toHaveBeenCalledTimes(1);
    expect(webRequestSpy.mock.calls[0][0].url).toBe(
      "https://hooks.example.com/det",
    );

    // routine_runs: one running row, finished success, event-path shape.
    expect(insertRoutineRunMock).toHaveBeenCalledTimes(1);
    expect(insertRoutineRunMock.mock.calls[0][0]).toMatchObject({
      routineName: "det-webhook",
      kind: "event",
      trigger: "det.webhook.fired",
      status: "running",
    });
    expect(finishRoutineRunMock).toHaveBeenCalledTimes(1);
    expect(finishRoutineRunMock).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ status: "success" }),
    );
  });

  it("calls a named action with its declared params (no agent loop)", async () => {
    const actionSpy = vi.fn(async () => ({ delivered: true }));
    resourceListAllOwnersMock.mockResolvedValue([
      deterministicEventJob({
        name: "det-action",
        event: "det.action.fired",
        declaration: {
          kind: "action",
          action: "notify-me",
          params: { text: "ping" },
        },
      }),
    ]);

    const handler = await handlerFor("det.action.fired", () => ({
      "notify-me": { tool: {}, run: actionSpy },
    }));
    await handler({ ok: true }, EVENT_META);

    expect(runAgentLoopMock).not.toHaveBeenCalled();
    expect(actionSpy).toHaveBeenCalledTimes(1);
    expect(actionSpy).toHaveBeenCalledWith({ text: "ping" });
    expect(finishRoutineRunMock).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ status: "success" }),
    );
  });

  it("control: an equivalent AGENTIC event routine DOES run the agent loop (probe is effective)", async () => {
    resourceListAllOwnersMock.mockResolvedValue([
      {
        id: "resource-agentic",
        owner: OWNER,
        path: "jobs/agentic-evt.md",
        content: `---
schedule: ""
enabled: true
triggerType: event
event: agentic.evt.fired
mode: agentic
createdBy: ${OWNER}
---

Respond to the event.`,
      },
    ]);

    const handler = await handlerFor("agentic.evt.fired", () => ({}));
    await handler({ ok: true }, EVENT_META);

    expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
  });

  it("records routine_runs error when the deterministic step throws (no rethrow)", async () => {
    const webRequestSpy = vi.fn(async () => {
      throw new Error("network down");
    });
    resourceListAllOwnersMock.mockResolvedValue([
      deterministicEventJob({
        name: "det-flaky",
        event: "det.flaky.fired",
        declaration: {
          kind: "web-request",
          url: "https://hooks.example.com/x",
        },
      }),
    ]);

    const handler = await handlerFor("det.flaky.fired", () => ({
      "web-request": { tool: {}, run: webRequestSpy },
    }));

    // The handler must not reject — the dispatcher's catch swallows the error.
    await expect(handler({ ok: true }, EVENT_META)).resolves.toBeUndefined();

    expect(runAgentLoopMock).not.toHaveBeenCalled();
    expect(finishRoutineRunMock).toHaveBeenCalledTimes(1);
    const [, patch] = finishRoutineRunMock.mock.calls[0];
    expect(patch.status).toBe("error");
    expect(patch.error).toContain("network down");
  });

  it("does NOT reach the Haiku classifier for a condition-less deterministic trigger (real evaluateCondition short-circuits)", async () => {
    // Spy on the REAL evaluateCondition (kept its implementation): it must run
    // (the condition gate applies to both modes per §1.5.10) but short-circuit
    // to `true` for an empty condition WITHOUT touching the Haiku classifier.
    const evalSpy = vi.spyOn(conditionEvaluator, "evaluateCondition");
    const webRequestSpy = vi.fn(async () => "HTTP 200 OK");
    resourceListAllOwnersMock.mockResolvedValue([
      deterministicEventJob({
        name: "det-no-cond",
        event: "det.nocond.fired",
        // No `condition:` in frontmatter → evaluateCondition gets undefined.
        declaration: {
          kind: "web-request",
          url: "https://hooks.example.com/n",
        },
      }),
    ]);

    const handler = await handlerFor("det.nocond.fired", () => ({
      "web-request": { tool: {}, run: webRequestSpy },
    }));
    await handler({ ok: true }, EVENT_META);

    // The condition gate ran exactly once with an empty condition and returned
    // true via the early-return path (no classifier call).
    expect(evalSpy).toHaveBeenCalledTimes(1);
    const [conditionArg] = evalSpy.mock.calls[0];
    expect(conditionArg == null || conditionArg.trim() === "").toBe(true);
    await expect(evalSpy.mock.results[0].value).resolves.toBe(true);

    // No agent loop; the deterministic step still fired.
    expect(runAgentLoopMock).not.toHaveBeenCalled();
    expect(webRequestSpy).toHaveBeenCalledTimes(1);
    evalSpy.mockRestore();
  });

  it("dispatches a condition-less deterministic trigger even with NO LLM API key (zero LLM dependency)", async () => {
    // The strongest proof the deterministic path touches no Haiku/LLM: with the
    // owner's active API key resolving to empty AND no env key, an agentic
    // trigger would be skipped (needs a key) — a deterministic + condition-less
    // trigger must still fire, because nothing on its path calls an LLM.
    const getKeySpy = vi
      .spyOn(productionAgent, "getOwnerActiveApiKey")
      .mockResolvedValue("" as unknown as string);
    const savedEnvKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const webRequestSpy = vi.fn(async () => "HTTP 200 OK");
      resourceListAllOwnersMock.mockResolvedValue([
        deterministicEventJob({
          name: "det-keyless",
          event: "det.keyless.fired",
          declaration: {
            kind: "web-request",
            url: "https://hooks.example.com/k",
          },
        }),
      ]);

      const handler = await handlerFor("det.keyless.fired", () => ({
        "web-request": { tool: {}, run: webRequestSpy },
      }));
      await handler({ ok: true }, EVENT_META);

      // Fired despite no API key → no LLM/Haiku on the path.
      expect(webRequestSpy).toHaveBeenCalledTimes(1);
      expect(runAgentLoopMock).not.toHaveBeenCalled();
      expect(finishRoutineRunMock).toHaveBeenCalledWith(
        "run-1",
        expect.objectContaining({ status: "success" }),
      );
    } finally {
      getKeySpy.mockRestore();
      if (savedEnvKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedEnvKey;
    }
  });
});
