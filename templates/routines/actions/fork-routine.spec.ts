/**
 * fork-routine — Phase A5 acceptance (§1.5.15):
 *  - forking a preset writes `jobs/{slug}.md` into the CURRENT owner via
 *    `resourcePut`, owned by the requesting user (fork = copy-to-owner).
 *  - the written content goes through the engine's `buildTriggerContent` and
 *    parses back (via the real `parseTriggerFrontmatter`) to the preset's
 *    trigger fields — so a forked routine round-trips like a saved one.
 *  - same-name collision appends `-2`, `-3`, … (§1.5.15 避让).
 *  - an event preset triggers `refreshEventSubscriptions()` so the subscription
 *    is live immediately; a schedule preset does not need it.
 *  - an unknown preset id is rejected with a clear error and writes nothing.
 *  - cross-user isolation: the collision probe is owner-scoped, so user B's
 *    fork is unaffected by user A's identically-named routine.
 *
 * `@agent-native/core/resources/store` and `request-context` are mocked; the
 * real `@agent-native/core/triggers` is used so the round-trip assertion
 * exercises the genuine serializer/parser. `refreshEventSubscriptions` is spied.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
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
vi.mock("@agent-native/core/triggers", async (importActual) => {
  const actual =
    await importActual<typeof import("@agent-native/core/triggers")>();
  return { ...actual, refreshEventSubscriptions };
});

const { default: forkRoutine } = await import("./fork-routine.js");

function putResult(path: string) {
  return {
    id: "res_1",
    owner: ctx.email,
    path,
    content: "",
    updatedAt: new Date("2026-06-21T00:00:00.000Z"),
  };
}

describe("fork-routine", () => {
  beforeEach(() => {
    store.resourcePut.mockReset();
    store.resourceGetByPath.mockReset();
    store.resourceListAllOwners.mockReset();
    refreshEventSubscriptions.mockReset();
    refreshEventSubscriptions.mockResolvedValue(undefined);
    ctx.email = "owner@example.com";
    ctx.orgId = undefined;
    // No existing routine for this owner by default.
    store.resourceGetByPath.mockResolvedValue(null);
    store.resourcePut.mockImplementation(async (_o: string, path: string) =>
      putResult(path),
    );
  });

  it("forks a schedule preset into the owner and round-trips the trigger", async () => {
    const result = await forkRoutine.run({ presetId: "daily-briefing" });

    expect(store.resourcePut).toHaveBeenCalledTimes(1);
    const [owner, path, content] = store.resourcePut.mock.calls[0];
    expect(owner).toBe("owner@example.com");
    expect(path).toBe("jobs/daily-briefing.md");

    const { meta, body } = parseTriggerFrontmatter(content as string);
    expect(meta.triggerType).toBe("schedule");
    expect(meta.schedule).toBe("30 8 * * 1-5");
    expect(meta.mode).toBe("agentic");
    expect(meta.domain).toBe("briefing");
    expect(meta.createdBy).toBe("owner@example.com");
    expect(meta.enabled).toBe(true);
    expect(body).toContain("chief-of-staff");

    expect(result.forked).toBe(true);
    expect(result.presetId).toBe("daily-briefing");
    expect(result.routine.name).toBe("daily-briefing");
    expect(result.routine.kind).toBe("schedule");
    // A schedule fork needs no subscription refresh.
    expect(refreshEventSubscriptions).not.toHaveBeenCalled();
  });

  it("forks the evening-recap preset (kind=evening A2A) and round-trips the trigger", async () => {
    // Phase C §454: the evening recap is a weekday-evening schedule routine that
    // calls the chief-of-staff agent over A2A with a kind=evening prompt.
    const result = await forkRoutine.run({ presetId: "evening-recap" });

    const [owner, path, content] = store.resourcePut.mock.calls[0];
    expect(owner).toBe("owner@example.com");
    expect(path).toBe("jobs/evening-recap.md");

    const { meta, body } = parseTriggerFrontmatter(content as string);
    expect(meta.triggerType).toBe("schedule");
    expect(meta.schedule).toBe("30 18 * * 1-5");
    expect(meta.mode).toBe("agentic");
    expect(meta.domain).toBe("briefing");
    expect(meta.enabled).toBe(true);
    // Body drives the CoS agent to compile an evening recap over A2A.
    expect(body).toContain("chief-of-staff");
    expect(body).toContain("kind=evening");

    expect(result.routine.name).toBe("evening-recap");
    expect(result.routine.kind).toBe("schedule");
    expect(refreshEventSubscriptions).not.toHaveBeenCalled();
  });

  it("forks a deterministic preset preserving the fenced json step body", async () => {
    const result = await forkRoutine.run({ presetId: "daily-webhook-ping" });

    const [, path, content] = store.resourcePut.mock.calls[0];
    expect(path).toBe("jobs/daily-webhook-ping.md");

    const { meta, body } = parseTriggerFrontmatter(content as string);
    expect(meta.mode).toBe("deterministic");
    expect(meta.triggerType).toBe("schedule");
    expect(meta.schedule).toBe("0 9 * * *");
    // The deterministic step survives as a fenced ```json block.
    expect(body).toContain("```json");
    expect(body).toContain('"kind": "web-request"');
    expect(body).toContain("${keys.STATUS_WEBHOOK}");

    expect(result.routine.mode).toBe("deterministic");
  });

  it("forks an event preset and refreshes subscriptions immediately", async () => {
    const result = await forkRoutine.run({ presetId: "pr-recap-on-plan" });

    const [, path, content] = store.resourcePut.mock.calls[0];
    expect(path).toBe("jobs/pr-recap-on-plan.md");

    const { meta } = parseTriggerFrontmatter(content as string);
    expect(meta.triggerType).toBe("event");
    expect(meta.event).toBe("plan.created");
    expect(meta.sourceApp).toBe("plan");
    expect(meta.condition).toBe("the plan is a merged-PR recap");
    // Empty schedule so the cron scheduler skips an event routine (§1.5.8).
    expect(meta.schedule).toBe("");

    expect(result.routine.kind).toBe("event");
    expect(result.routine.event).toBe("plan.created");
    expect(result.routine.sourceApp).toBe("plan");
    // Event forks subscribe right away.
    expect(refreshEventSubscriptions).toHaveBeenCalledTimes(1);
  });

  it("appends a numeric suffix on a same-name collision (§1.5.15)", async () => {
    // The bare slug and -2 are taken; -3 is free.
    store.resourceGetByPath.mockImplementation(
      async (_owner: string, path: string) => {
        if (
          path === "jobs/daily-briefing.md" ||
          path === "jobs/daily-briefing-2.md"
        ) {
          return putResult(path);
        }
        return null;
      },
    );

    const result = await forkRoutine.run({ presetId: "daily-briefing" });

    const [, path] = store.resourcePut.mock.calls[0];
    expect(path).toBe("jobs/daily-briefing-3.md");
    expect(result.routine.name).toBe("daily-briefing-3");
  });

  it("honors an explicit name override, slugged", async () => {
    const result = await forkRoutine.run({
      presetId: "daily-briefing",
      name: "My Morning Brief!!",
    });
    const [, path] = store.resourcePut.mock.calls[0];
    expect(path).toBe("jobs/my-morning-brief.md");
    expect(result.routine.name).toBe("my-morning-brief");
  });

  it("rejects an unknown preset id and writes nothing", async () => {
    await expect(
      forkRoutine.run({ presetId: "does-not-exist" }),
    ).rejects.toThrow(/no routine template/i);
    expect(store.resourcePut).not.toHaveBeenCalled();
  });

  it("is owner-scoped: user B's fork is unaffected by user A's same-named routine", async () => {
    // Model real owner scoping: the probe only sees the requesting owner's rows.
    // Alice already has `daily-briefing`; Bob has none.
    store.resourceGetByPath.mockImplementation(
      async (owner: string, path: string) =>
        owner === "alice@example.com" && path === "jobs/daily-briefing.md"
          ? putResult(path)
          : null,
    );

    ctx.email = "bob@example.com";
    const result = await forkRoutine.run({ presetId: "daily-briefing" });

    const [owner, path] = store.resourcePut.mock.calls[0];
    expect(owner).toBe("bob@example.com");
    // Bob gets the bare slug — Alice's identically-named routine never collides.
    expect(path).toBe("jobs/daily-briefing.md");
    expect(result.routine.name).toBe("daily-briefing");
  });
});
