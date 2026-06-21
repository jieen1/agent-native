/**
 * save-routine — Phase A1 acceptance:
 *  - invalid cron is rejected by `isValidCron` BEFORE any write; no file is
 *    produced (assert `resourcePut` was never called).
 *  - a valid create writes `jobs/{name}.md` via `buildTriggerContent` and the
 *    written content parses back (through the engine's `parseJobFrontmatter`) to
 *    the schedule/enabled the UI gave (§ acceptance line 255).
 *  - create vs update is explicit: create refuses an existing routine, update
 *    refuses a missing one.
 *  - the slug rule (§1.5.15) decouples the file name from the display name.
 *
 * `@agent-native/core/resources/store` and `request-context` are mocked; the
 * real `@agent-native/core/triggers` + `@agent-native/core/jobs` are used so the
 * round-trip assertion exercises the genuine serializer/parser.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseJobFrontmatter } from "@agent-native/core/jobs";
import { parseTriggerFrontmatter } from "@agent-native/core/triggers";

const store = vi.hoisted(() => ({
  resourcePut: vi.fn(),
  resourceGetByPath: vi.fn(),
  resourceListAllOwners: vi.fn(),
  resourceDelete: vi.fn(),
}));
const ctx = vi.hoisted(() => ({
  email: "owner@example.com" as string | undefined,
  orgId: undefined as string | undefined,
}));
const refreshEventSubscriptions = vi.hoisted(() => vi.fn());

vi.mock("@agent-native/core/resources/store", () => store);
vi.mock("@agent-native/core/server/request-context", () => ({
  getRequestUserEmail: () => ctx.email,
  getRequestOrgId: () => ctx.orgId,
}));
// Keep the real serializer/parser; spy only on refreshEventSubscriptions so we
// can assert it fires after a write without touching the bus.
vi.mock("@agent-native/core/triggers", async (importActual) => {
  const actual =
    await importActual<typeof import("@agent-native/core/triggers")>();
  return { ...actual, refreshEventSubscriptions };
});

const { default: saveRoutine } = await import("./save-routine.js");

function putResult(path: string) {
  return {
    id: "res_1",
    owner: ctx.email,
    path,
    content: "",
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  };
}

describe("save-routine", () => {
  beforeEach(() => {
    store.resourcePut.mockReset();
    store.resourceGetByPath.mockReset();
    store.resourceListAllOwners.mockReset();
    store.resourceListAllOwners.mockResolvedValue([]);
    refreshEventSubscriptions.mockReset();
    refreshEventSubscriptions.mockResolvedValue(undefined);
    ctx.email = "owner@example.com";
    ctx.orgId = undefined;
    store.resourceGetByPath.mockResolvedValue(null);
    store.resourcePut.mockImplementation(async (_o: string, path: string) =>
      putResult(path),
    );
  });

  it("rejects an invalid cron and writes nothing", async () => {
    await expect(
      saveRoutine.run({
        mode: "create",
        displayName: "Bad One",
        schedule: "not-a-cron",
        instructions: "x",
        enabled: true,
      }),
    ).rejects.toThrow(/invalid cron/i);

    expect(store.resourcePut).not.toHaveBeenCalled();
  });

  it("creates a schedule routine and the written file parses back to the same schedule/enabled", async () => {
    const result = await saveRoutine.run({
      mode: "create",
      displayName: "Morning Briefing",
      schedule: "30 8 * * *",
      instructions: "Compile my morning briefing.",
      enabled: true,
    });

    expect(store.resourcePut).toHaveBeenCalledTimes(1);
    const [owner, path, content] = store.resourcePut.mock.calls[0];
    expect(owner).toBe("owner@example.com");
    // §1.5.15: file name is a slug of the display name, decoupled from it.
    expect(path).toBe("jobs/morning-briefing.md");

    // The engine's own parser recovers exactly what the UI supplied.
    const { meta, body } = parseJobFrontmatter(content as string);
    expect(meta.schedule).toBe("30 8 * * *");
    expect(meta.enabled).toBe(true);
    expect(body).toBe("Compile my morning briefing.");

    // The serialized content went through buildTriggerContent (triggerType set).
    expect(content).toContain("triggerType: schedule");
    expect(content).toContain("mode: agentic");

    expect(result.created).toBe(true);
    expect(result.routine.name).toBe("morning-briefing");
    expect(result.routine.schedule).toBe("30 8 * * *");
  });

  it("persists enabled:false when requested", async () => {
    await saveRoutine.run({
      mode: "create",
      displayName: "Paused Job",
      schedule: "0 * * * *",
      instructions: "later",
      enabled: false,
    });
    const content = store.resourcePut.mock.calls[0][2] as string;
    const { meta } = parseJobFrontmatter(content);
    expect(meta.enabled).toBe(false);
  });

  it("create refuses to overwrite an existing routine (no write)", async () => {
    store.resourceGetByPath.mockResolvedValue({
      id: "res_existing",
      owner: "owner@example.com",
      path: "jobs/morning-briefing.md",
      content:
        '---\nschedule: "0 9 * * *"\nenabled: true\ntriggerType: schedule\nmode: agentic\n---\n\nold',
      updatedAt: new Date(),
    });

    await expect(
      saveRoutine.run({
        mode: "create",
        displayName: "Morning Briefing",
        schedule: "30 8 * * *",
        instructions: "new",
        enabled: true,
      }),
    ).rejects.toThrow(/already exists/i);
    expect(store.resourcePut).not.toHaveBeenCalled();
  });

  it("update refuses a missing routine (no write)", async () => {
    store.resourceGetByPath.mockResolvedValue(null);

    await expect(
      saveRoutine.run({
        mode: "update",
        name: "ghost",
        schedule: "30 8 * * *",
        instructions: "x",
        enabled: true,
      }),
    ).rejects.toThrow(/no routine named/i);
    expect(store.resourcePut).not.toHaveBeenCalled();
  });

  it("update preserves engine-written run history (lastRun/lastStatus)", async () => {
    store.resourceGetByPath.mockResolvedValue({
      id: "res_existing",
      owner: "owner@example.com",
      path: "jobs/daily.md",
      content:
        '---\nschedule: "0 9 * * *"\nenabled: true\ntriggerType: schedule\nmode: agentic\nlastRun: 2026-06-19T09:00:00.000Z\nlastStatus: success\ncreatedBy: owner@example.com\n---\n\nold body',
      updatedAt: new Date(),
    });

    await saveRoutine.run({
      mode: "update",
      name: "daily",
      schedule: "0 10 * * *",
      instructions: "new body",
      enabled: true,
    });

    const content = store.resourcePut.mock.calls[0][2] as string;
    const { meta, body } = parseJobFrontmatter(content);
    expect(meta.schedule).toBe("0 10 * * *");
    expect(meta.lastRun).toBe("2026-06-19T09:00:00.000Z");
    expect(meta.lastStatus).toBe("success");
    expect(body).toBe("new body");
  });

  it("throws when the request is unauthenticated (no write)", async () => {
    ctx.email = undefined;
    await expect(
      saveRoutine.run({
        mode: "create",
        displayName: "X",
        schedule: "30 8 * * *",
        instructions: "x",
        enabled: true,
      }),
    ).rejects.toThrow(/no authenticated user/i);
    expect(store.resourcePut).not.toHaveBeenCalled();
  });

  // ─── Phase A2: event kind ──────────────────────────────────────────────────

  it("creates an event routine: triggerType=event, schedule blank, condition kept", async () => {
    const result = await saveRoutine.run({
      mode: "create",
      kind: "event",
      displayName: "On New Plan",
      event: "plan.created",
      condition: "the plan is a recap",
      instructions: "Summarize the new plan.",
      enabled: true,
    });

    expect(store.resourcePut).toHaveBeenCalledTimes(1);
    const [, path, content] = store.resourcePut.mock.calls[0];
    expect(path).toBe("jobs/on-new-plan.md");

    const { meta, body } = parseTriggerFrontmatter(content as string);
    expect(meta.triggerType).toBe("event");
    expect(meta.event).toBe("plan.created");
    expect(meta.condition).toBe("the plan is a recap");
    expect(meta.mode).toBe("agentic");
    // §1.5.8: event routines write an EMPTY schedule so the cron scheduler
    // (which validates the cron) skips them — only the dispatcher runs them.
    expect(meta.schedule).toBe("");
    expect(body).toBe("Summarize the new plan.");

    expect(result.created).toBe(true);
    expect(result.routine.kind).toBe("event");
    expect(result.routine.event).toBe("plan.created");

    // Subscriptions are refreshed so the new event routine subscribes at once.
    expect(refreshEventSubscriptions).toHaveBeenCalledTimes(1);
  });

  it("rejects an event routine with no event name (no write)", async () => {
    await expect(
      saveRoutine.run({
        mode: "create",
        kind: "event",
        displayName: "Bad Event",
        instructions: "x",
        enabled: true,
      }),
    ).rejects.toThrow(/requires an --event/i);
    expect(store.resourcePut).not.toHaveBeenCalled();
    expect(refreshEventSubscriptions).not.toHaveBeenCalled();
  });

  it("switching schedule → event blanks the cron schedule", async () => {
    store.resourceGetByPath.mockResolvedValue({
      id: "res_existing",
      owner: "owner@example.com",
      path: "jobs/switcher.md",
      content:
        '---\nschedule: "0 9 * * *"\nenabled: true\ntriggerType: schedule\nmode: agentic\ncreatedBy: owner@example.com\n---\n\nbody',
      updatedAt: new Date(),
    });

    await saveRoutine.run({
      mode: "update",
      kind: "event",
      name: "switcher",
      event: "agent.turn.completed",
      instructions: "react",
      enabled: true,
    });

    const content = store.resourcePut.mock.calls[0][2] as string;
    const { meta } = parseTriggerFrontmatter(content);
    expect(meta.triggerType).toBe("event");
    expect(meta.event).toBe("agent.turn.completed");
    expect(meta.schedule).toBe("");
  });

  it("switching event → schedule clears the event/condition", async () => {
    store.resourceGetByPath.mockResolvedValue({
      id: "res_existing",
      owner: "owner@example.com",
      path: "jobs/switcher.md",
      content:
        '---\nschedule: ""\nenabled: true\ntriggerType: event\nevent: plan.created\ncondition: "x"\nmode: agentic\ncreatedBy: owner@example.com\n---\n\nbody',
      updatedAt: new Date(),
    });

    await saveRoutine.run({
      mode: "update",
      kind: "schedule",
      name: "switcher",
      schedule: "0 8 * * *",
      instructions: "tick",
      enabled: true,
    });

    const content = store.resourcePut.mock.calls[0][2] as string;
    const { meta } = parseTriggerFrontmatter(content);
    expect(meta.triggerType).toBe("schedule");
    expect(meta.schedule).toBe("0 8 * * *");
    expect(meta.event).toBeUndefined();
    expect(meta.condition).toBeUndefined();
  });

  it("a schedule write still refreshes subscriptions (no-op but consistent)", async () => {
    await saveRoutine.run({
      mode: "create",
      kind: "schedule",
      displayName: "Daily",
      schedule: "0 8 * * *",
      instructions: "x",
      enabled: true,
    });
    expect(refreshEventSubscriptions).toHaveBeenCalledTimes(1);
  });

  // ─── Phase A4: deterministic mode ──────────────────────────────────────────

  it("creates a deterministic schedule routine: mode=deterministic, body is a fenced json step", async () => {
    const result = await saveRoutine.run({
      mode: "create",
      kind: "schedule",
      executionMode: "deterministic",
      displayName: "Webhook Ping",
      schedule: "0 9 * * *",
      stepDeclaration: JSON.stringify({
        kind: "web-request",
        method: "POST",
        url: "https://hooks.example.com/${keys.WEBHOOK}",
      }),
      enabled: true,
    });

    expect(store.resourcePut).toHaveBeenCalledTimes(1);
    const content = store.resourcePut.mock.calls[0][2] as string;
    const { meta, body } = parseTriggerFrontmatter(content);
    expect(meta.mode).toBe("deterministic");
    expect(meta.schedule).toBe("0 9 * * *");
    // Body is a fenced ```json block holding the validated, normalized step.
    expect(body).toMatch(/```json/);
    const json = body.replace(/```json\s*|\s*```/g, "");
    const parsed = JSON.parse(json);
    expect(parsed).toEqual({
      kind: "web-request",
      method: "POST",
      url: "https://hooks.example.com/${keys.WEBHOOK}",
    });
    expect(result.created).toBe(true);
    expect(result.routine.mode).toBe("deterministic");
  });

  it("creates a deterministic event routine with an action step", async () => {
    const content = await (async () => {
      await saveRoutine.run({
        mode: "create",
        kind: "event",
        executionMode: "deterministic",
        displayName: "On Plan Notify",
        event: "plan.created",
        stepDeclaration: JSON.stringify({
          kind: "action",
          action: "notify-me",
          params: { text: "new plan" },
        }),
        enabled: true,
      });
      return store.resourcePut.mock.calls[0][2] as string;
    })();

    const { meta, body } = parseTriggerFrontmatter(content);
    expect(meta.triggerType).toBe("event");
    expect(meta.mode).toBe("deterministic");
    expect(meta.event).toBe("plan.created");
    const parsed = JSON.parse(body.replace(/```json\s*|\s*```/g, ""));
    expect(parsed).toEqual({
      kind: "action",
      action: "notify-me",
      params: { text: "new plan" },
    });
  });

  it("rejects deterministic mode with no stepDeclaration (no write)", async () => {
    await expect(
      saveRoutine.run({
        mode: "create",
        kind: "schedule",
        executionMode: "deterministic",
        displayName: "Missing Step",
        schedule: "0 9 * * *",
        enabled: true,
      }),
    ).rejects.toThrow(/requires a .*stepDeclaration/i);
    expect(store.resourcePut).not.toHaveBeenCalled();
  });

  it("rejects an unknown step kind with a field-level reason (no file produced)", async () => {
    await expect(
      saveRoutine.run({
        mode: "create",
        kind: "schedule",
        executionMode: "deterministic",
        displayName: "Bad Kind",
        schedule: "0 9 * * *",
        stepDeclaration: JSON.stringify({ kind: "shell", cmd: "rm -rf /" }),
        enabled: true,
      }),
    ).rejects.toThrow(/Invalid deterministic step declaration/i);
    expect(store.resourcePut).not.toHaveBeenCalled();
  });

  it("rejects a multi-step array declaration (no write)", async () => {
    await expect(
      saveRoutine.run({
        mode: "create",
        kind: "schedule",
        executionMode: "deterministic",
        displayName: "Multi Step",
        schedule: "0 9 * * *",
        stepDeclaration: JSON.stringify([
          { kind: "action", action: "a" },
          { kind: "action", action: "b" },
        ]),
        enabled: true,
      }),
    ).rejects.toThrow(/Invalid deterministic step declaration/i);
    expect(store.resourcePut).not.toHaveBeenCalled();
  });

  it("rejects a web-request step missing url with a field-level reason (no write)", async () => {
    await expect(
      saveRoutine.run({
        mode: "create",
        kind: "schedule",
        executionMode: "deterministic",
        displayName: "No URL",
        schedule: "0 9 * * *",
        stepDeclaration: JSON.stringify({
          kind: "web-request",
          method: "POST",
        }),
        enabled: true,
      }),
    ).rejects.toThrow(/url/i);
    expect(store.resourcePut).not.toHaveBeenCalled();
  });

  it("rejects malformed stepDeclaration JSON (no write)", async () => {
    await expect(
      saveRoutine.run({
        mode: "create",
        kind: "schedule",
        executionMode: "deterministic",
        displayName: "Bad JSON",
        schedule: "0 9 * * *",
        stepDeclaration: "{ not json",
        enabled: true,
      }),
    ).rejects.toThrow(/not valid JSON/i);
    expect(store.resourcePut).not.toHaveBeenCalled();
  });
});
