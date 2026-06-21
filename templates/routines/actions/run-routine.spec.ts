/**
 * run-routine — manual run / dry-run (§1.5.11/12).
 *
 * Event path (the spec-critical one):
 *   - per §1.5.11 it must NOT use fire-test; it evaluates the routine's
 *     condition against the SAMPLE payload with the real `condition-evaluator`
 *     seam and, on a match, `emit`s the routine's OWN event (not
 *     test.event.fired) scoped to the owner so the dispatcher path runs it.
 *   - when the condition does not match, it does not emit and reports
 *     conditionMatched:false.
 *
 * Schedule path:
 *   - routes to the run-manager path (does NOT emit any event) and, crucially,
 *     NEVER writes the routine resource, so the cron `nextRun` is untouched.
 *   - writes exactly one routine_runs history row with trigger:"manual".
 *
 * The resources store, request-context, condition-evaluator (via the triggers
 * barrel), event bus, routine-runs store, and the heavy engine deps are mocked.
 * The engine `runAgentLoop` is stubbed to resolve immediately so the schedule
 * path is observable without a real model call.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "owner@example.com";

const store = vi.hoisted(() => ({
  resourceGetByPath: vi.fn(),
  resourceListAllOwners: vi.fn(),
  resourcePut: vi.fn(),
  resourceDelete: vi.fn(),
}));
const ctx = vi.hoisted(() => ({
  email: "owner@example.com" as string | undefined,
  orgId: undefined as string | undefined,
}));
const evaluateCondition = vi.hoisted(() => vi.fn());
const emit = vi.hoisted(() => vi.fn());
const runs = vi.hoisted(() => ({
  insertRoutineRun: vi.fn(),
  finishRoutineRun: vi.fn(),
}));
const engine = vi.hoisted(() => ({
  runAgentLoop: vi.fn(),
  getOwnerActiveApiKey: vi.fn(),
  createThread: vi.fn(),
}));

vi.mock("@agent-native/core/resources/store", () => store);
vi.mock("@agent-native/core/server/request-context", () => ({
  getRequestUserEmail: () => ctx.email,
  getRequestOrgId: () => ctx.orgId,
  runWithRequestContext: (_c: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@agent-native/core/triggers", async (importActual) => {
  const actual =
    await importActual<typeof import("@agent-native/core/triggers")>();
  return { ...actual, evaluateCondition };
});
vi.mock("@agent-native/core/event-bus", () => ({ emit }));
vi.mock("@agent-native/core/routine-runs", () => runs);
vi.mock("@agent-native/core/server", () => ({
  runAgentLoop: engine.runAgentLoop,
  getOwnerActiveApiKey: engine.getOwnerActiveApiKey,
  createThread: engine.createThread,
  actionsToEngineTools: () => [],
  getStoredModelForEngine: async () => "test-model",
  resolveEngine: async () => ({ name: "test", defaultModel: "test-model" }),
  loadActionsFromStaticRegistry: () => ({}),
  getRequestOrgId: () => ctx.orgId,
  runWithRequestContext: (_c: unknown, fn: () => unknown) => fn(),
}));

const { default: runRoutine } = await import("./run-routine.js");

function eventResource(opts: {
  name: string;
  event?: string;
  condition?: string;
  body?: string;
  owner?: string;
}) {
  const { name, event = "plan.created", condition, body = "do it" } = opts;
  const lines = [
    "---",
    'schedule: ""',
    "enabled: true",
    "triggerType: event",
    `event: ${event}`,
  ];
  if (condition) lines.push(`condition: "${condition}"`);
  lines.push(
    "mode: agentic",
    `createdBy: ${opts.owner ?? OWNER}`,
    "---",
    "",
    body,
  );
  return {
    id: `res_${name}`,
    owner: opts.owner ?? OWNER,
    path: `jobs/${name}.md`,
    content: lines.join("\n"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  };
}

function scheduleResource(opts: { name: string; body?: string }) {
  const { name, body = "do it" } = opts;
  const content = [
    "---",
    'schedule: "0 8 * * *"',
    "enabled: true",
    "triggerType: schedule",
    "mode: agentic",
    "nextRun: 2999-01-01T00:00:00.000Z",
    `createdBy: ${OWNER}`,
    "---",
    "",
    body,
  ].join("\n");
  return {
    id: `res_${name}`,
    owner: OWNER,
    path: `jobs/${name}.md`,
    content,
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  };
}

describe("run-routine", () => {
  beforeEach(() => {
    store.resourceGetByPath.mockReset();
    store.resourcePut.mockReset();
    evaluateCondition.mockReset();
    emit.mockReset();
    runs.insertRoutineRun.mockReset();
    runs.insertRoutineRun.mockResolvedValue("run_1");
    runs.finishRoutineRun.mockReset();
    runs.finishRoutineRun.mockResolvedValue(undefined);
    engine.runAgentLoop.mockReset();
    engine.runAgentLoop.mockResolvedValue(undefined);
    engine.getOwnerActiveApiKey.mockReset();
    engine.getOwnerActiveApiKey.mockResolvedValue("sk-test");
    engine.createThread.mockReset();
    engine.createThread.mockResolvedValue({ id: "thread_1" });
    ctx.email = OWNER;
    ctx.orgId = undefined;
  });

  it("returns notFound for a routine that doesn't exist for the owner", async () => {
    store.resourceGetByPath.mockResolvedValue(null);
    const result = await runRoutine.run({ name: "ghost" });
    expect(result).toEqual({ notFound: true, name: "ghost" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("event: emits the routine's OWN event (not fire-test) when the condition matches", async () => {
    store.resourceGetByPath.mockResolvedValue(
      eventResource({ name: "on-new-plan", condition: "is a recap" }),
    );
    evaluateCondition.mockResolvedValue(true);

    const result = await runRoutine.run({
      name: "on-new-plan",
      samplePayload: { plan: { kind: "recap" } },
    });

    // Condition evaluated against the SAMPLE payload.
    expect(evaluateCondition).toHaveBeenCalledWith(
      "is a recap",
      { plan: { kind: "recap" } },
      "sk-test",
    );
    // Emits the routine's real event, owner-scoped — NOT test.event.fired.
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      "plan.created",
      { plan: { kind: "recap" } },
      { owner: OWNER },
    );
    expect(result).toMatchObject({
      kind: "event",
      conditionMatched: true,
      dispatched: true,
      event: "plan.created",
    });
  });

  it("event: does NOT emit when the condition fails", async () => {
    store.resourceGetByPath.mockResolvedValue(
      eventResource({ name: "on-new-plan", condition: "is a recap" }),
    );
    evaluateCondition.mockResolvedValue(false);

    const result = await runRoutine.run({
      name: "on-new-plan",
      samplePayload: { plan: { kind: "design" } },
    });

    expect(emit).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      kind: "event",
      conditionMatched: false,
      dispatched: false,
    });
  });

  it("event: a condition-less routine matches and dispatches", async () => {
    store.resourceGetByPath.mockResolvedValue(
      eventResource({ name: "always" }),
    );
    // Real evaluateCondition returns true for empty condition; the mock mirrors.
    evaluateCondition.mockResolvedValue(true);

    const result = await runRoutine.run({ name: "always" });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ dispatched: true, conditionMatched: true });
  });

  it("schedule: runs via the agent loop, writes ONE manual history row, never touches the routine resource (nextRun untouched)", async () => {
    store.resourceGetByPath.mockResolvedValue(
      scheduleResource({ name: "daily-brief" }),
    );

    const result = await runRoutine.run({ name: "daily-brief" });

    // Did not emit any event (this is the cron path, not the dispatcher path).
    expect(emit).not.toHaveBeenCalled();
    // Drove the real agent loop once.
    expect(engine.runAgentLoop).toHaveBeenCalledTimes(1);

    // Exactly one history row, marked manual, then finished success.
    expect(runs.insertRoutineRun).toHaveBeenCalledTimes(1);
    const insertArg = runs.insertRoutineRun.mock.calls[0][0];
    expect(insertArg).toMatchObject({
      ownerEmail: OWNER,
      routineName: "daily-brief",
      kind: "schedule",
      trigger: "manual",
      threadId: "thread_1",
      status: "running",
    });
    expect(runs.finishRoutineRun).toHaveBeenCalledWith(
      "run_1",
      expect.objectContaining({ status: "success" }),
    );

    // CRITICAL: a manual run must not advance the schedule — the routine
    // resource is never written, so nextRun is untouched.
    expect(store.resourcePut).not.toHaveBeenCalled();

    expect(result).toMatchObject({
      kind: "schedule",
      status: "success",
      threadId: "thread_1",
    });
  });

  it("schedule: a failing run records an error history row and still leaves the schedule alone", async () => {
    store.resourceGetByPath.mockResolvedValue(
      scheduleResource({ name: "daily-brief" }),
    );
    engine.runAgentLoop.mockRejectedValue(new Error("model exploded"));

    const result = await runRoutine.run({ name: "daily-brief" });

    expect(runs.finishRoutineRun).toHaveBeenCalledWith(
      "run_1",
      expect.objectContaining({ status: "error", error: "model exploded" }),
    );
    expect(store.resourcePut).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: "schedule", status: "error" });
  });
});
