/**
 * set-routine-enabled — owner-scoped enable/disable toggle.
 *
 *  - Disabling rewrites the routine with enabled:false through the real
 *    buildTriggerContent (triggerType + other fields preserved) and keeps the
 *    existing nextRun.
 *  - Enabling clears nextRun so the scheduler recomputes it from the cron.
 *  - A missing/other-owner routine returns { notFound: true } with no write.
 *  - refreshEventSubscriptions is called so an event routine (un)subscribes
 *    immediately; a refresh failure must not mask the saved toggle.
 *  - An invalid slug throws before any read/write.
 *
 * The real `@agent-native/core/triggers` serializer/parser runs so the rewritten
 * content round-trips; only the store, context, and refreshEventSubscriptions are
 * mocked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTriggerContent,
  parseTriggerFrontmatter,
  type TriggerFrontmatter,
} from "@agent-native/core/triggers";

const store = vi.hoisted(() => ({
  resourceGetByPath: vi.fn(),
  resourcePut: vi.fn(),
}));
const ctx = vi.hoisted(() => ({
  email: "owner@example.com" as string | undefined,
}));
const refreshEventSubscriptions = vi.hoisted(() => vi.fn());

vi.mock("@agent-native/core/resources/store", () => store);
vi.mock("@agent-native/core/server/request-context", () => ({
  getRequestUserEmail: () => ctx.email,
  getRequestOrgId: () => undefined,
}));
vi.mock("@agent-native/core/triggers", async (importActual) => {
  const actual =
    await importActual<typeof import("@agent-native/core/triggers")>();
  return { ...actual, refreshEventSubscriptions };
});

const { default: setRoutineEnabled } = await import("./set-routine-enabled.js");

function routineResource(meta: TriggerFrontmatter) {
  return {
    id: "res_1",
    owner: "owner@example.com",
    path: "jobs/morning.md",
    content: buildTriggerContent(meta, "do the work"),
    updatedAt: new Date("2026-06-21T00:00:00.000Z"),
  };
}

const enabledSchedule: TriggerFrontmatter = {
  schedule: "30 8 * * 1-5",
  enabled: true,
  triggerType: "schedule",
  mode: "agentic",
  nextRun: "2026-06-22T08:30:00.000Z",
};

/** The frontmatter the action wrote back. */
function writtenMeta(): TriggerFrontmatter {
  const [, , content] = store.resourcePut.mock.calls[0] as [
    string,
    string,
    string,
  ];
  return parseTriggerFrontmatter(content).meta;
}

describe("set-routine-enabled", () => {
  beforeEach(() => {
    store.resourceGetByPath.mockReset();
    store.resourcePut.mockReset();
    refreshEventSubscriptions.mockReset();
    refreshEventSubscriptions.mockResolvedValue(undefined);
    ctx.email = "owner@example.com";
    store.resourcePut.mockImplementation(async (_o, path: string) => ({
      id: "res_1",
      owner: "owner@example.com",
      path,
      content: "",
      updatedAt: new Date("2026-06-21T00:00:00.000Z"),
    }));
  });

  it("disables a routine, preserving triggerType and keeping nextRun", async () => {
    store.resourceGetByPath.mockResolvedValue(routineResource(enabledSchedule));

    const result = await setRoutineEnabled.run({
      name: "morning",
      enabled: false,
    });

    expect(store.resourcePut).toHaveBeenCalledTimes(1);
    const meta = writtenMeta();
    expect(meta.enabled).toBe(false);
    expect(meta.triggerType).toBe("schedule");
    expect(meta.schedule).toBe("30 8 * * 1-5");
    // Disabling keeps the existing nextRun.
    expect(meta.nextRun).toBe("2026-06-22T08:30:00.000Z");

    expect(result).toMatchObject({ routine: { enabled: false } });
    expect(refreshEventSubscriptions).toHaveBeenCalledTimes(1);
  });

  it("enabling clears nextRun so the scheduler recomputes it", async () => {
    store.resourceGetByPath.mockResolvedValue(
      routineResource({ ...enabledSchedule, enabled: false }),
    );

    await setRoutineEnabled.run({ name: "morning", enabled: true });

    const meta = writtenMeta();
    expect(meta.enabled).toBe(true);
    expect(meta.nextRun).toBeUndefined();
  });

  it("returns notFound with no write for a missing/other-owner routine", async () => {
    store.resourceGetByPath.mockResolvedValue(null);

    const result = await setRoutineEnabled.run({
      name: "ghost",
      enabled: false,
    });

    expect(result).toEqual({ notFound: true, name: "ghost" });
    expect(store.resourcePut).not.toHaveBeenCalled();
  });

  it("does not mask a saved toggle when subscription refresh fails", async () => {
    store.resourceGetByPath.mockResolvedValue(routineResource(enabledSchedule));
    refreshEventSubscriptions.mockRejectedValue(new Error("bus down"));

    const result = await setRoutineEnabled.run({
      name: "morning",
      enabled: false,
    });

    expect(result).toMatchObject({ routine: { enabled: false } });
    expect(store.resourcePut).toHaveBeenCalledTimes(1);
  });

  it("throws on an invalid slug before any read/write", async () => {
    await expect(
      setRoutineEnabled.run({ name: "@@@", enabled: true }),
    ).rejects.toThrow(/invalid routine name/i);
    expect(store.resourceGetByPath).not.toHaveBeenCalled();
    expect(store.resourcePut).not.toHaveBeenCalled();
  });
});
