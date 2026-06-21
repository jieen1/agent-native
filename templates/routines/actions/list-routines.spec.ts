/**
 * list-routines — empty state (§1.5.19) and owner/kind filtering.
 *
 *  - No routines anywhere -> returns { routines: [] } without throwing.
 *  - Returns only the requesting owner's resources (cross-user isolation).
 *  - Phase A2: returns BOTH schedule- and event-kind routines; an optional
 *    `kind` filter narrows to one kind. Event routines carry `event`/`condition`
 *    and an empty `describeCron`; schedule routines carry the cron + describeCron.
 *  - `.keep`/non-.md files are ignored.
 *
 * `resourceListAllOwners` + request-context are mocked; the real
 * `@agent-native/core/triggers` + `@agent-native/core/jobs` (describeCron) run.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTriggerContent,
  type TriggerFrontmatter,
} from "@agent-native/core/triggers";

const OWNER = "owner@example.com";

const store = vi.hoisted(() => ({
  resourceListAllOwners: vi.fn(),
  resourcePut: vi.fn(),
  resourceGetByPath: vi.fn(),
  resourceDelete: vi.fn(),
}));
const ctx = vi.hoisted(() => ({
  email: "owner@example.com" as string | undefined,
}));

vi.mock("@agent-native/core/resources/store", () => store);
vi.mock("@agent-native/core/server/request-context", () => ({
  getRequestUserEmail: () => ctx.email,
  getRequestOrgId: () => undefined,
}));

const { default: listRoutines } = await import("./list-routines.js");

function resource(
  owner: string,
  name: string,
  meta: TriggerFrontmatter,
  body = "do it",
) {
  return {
    id: `res_${name}`,
    owner,
    path: `jobs/${name}.md`,
    content: buildTriggerContent(meta, body),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  };
}

const schedule = (
  overrides: Partial<TriggerFrontmatter> = {},
): TriggerFrontmatter => ({
  schedule: "30 8 * * 1-5",
  enabled: true,
  triggerType: "schedule",
  mode: "agentic",
  ...overrides,
});

describe("list-routines", () => {
  beforeEach(() => {
    store.resourceListAllOwners.mockReset();
    ctx.email = OWNER;
  });

  it("returns an empty array when there are no routines (empty state, no throw)", async () => {
    store.resourceListAllOwners.mockResolvedValue([]);
    const result = await listRoutines.run({});
    expect(result).toEqual({ routines: [] });
  });

  it("returns an empty array when only other owners have routines", async () => {
    store.resourceListAllOwners.mockResolvedValue([
      resource("someone-else@example.com", "theirs", schedule()),
    ]);
    const result = await listRoutines.run({});
    expect(result.routines).toEqual([]);
  });

  it("returns the owner's schedule AND event routines, with the right per-kind fields", async () => {
    store.resourceListAllOwners.mockResolvedValue([
      resource(OWNER, "weekday-brief", schedule()),
      // event-kind: included in Phase A2
      resource(OWNER, "on-new-mail", {
        schedule: "",
        enabled: true,
        triggerType: "event",
        mode: "agentic",
        event: "mail.received",
        condition: "the sender is my boss",
      }),
      // another owner: filtered out
      resource("other@example.com", "not-mine", schedule()),
      // a .keep marker / non-md: ignored
      {
        id: "res_keep",
        owner: OWNER,
        path: "jobs/.keep",
        content: "",
        updatedAt: new Date(),
      },
    ]);

    const { routines } = await listRoutines.run({});
    expect(routines).toHaveLength(2);

    const sched = routines.find((r) => r.name === "weekday-brief")!;
    expect(sched.kind).toBe("schedule");
    expect(sched.schedule).toBe("30 8 * * 1-5");
    expect(sched.describeCron).toBe("Every weekday at 8:30 AM");
    expect(sched.enabled).toBe(true);

    const event = routines.find((r) => r.name === "on-new-mail")!;
    expect(event.kind).toBe("event");
    expect(event.event).toBe("mail.received");
    expect(event.condition).toBe("the sender is my boss");
    // Event routines have no cron-derived fields.
    expect(event.schedule).toBe("");
    expect(event.describeCron).toBe("");
    expect(event.nextRun).toBeUndefined();
  });

  it("narrows to a single kind when `kind` is passed", async () => {
    store.resourceListAllOwners.mockResolvedValue([
      resource(OWNER, "weekday-brief", schedule()),
      resource(OWNER, "on-new-mail", {
        schedule: "",
        enabled: true,
        triggerType: "event",
        mode: "agentic",
        event: "mail.received",
      }),
    ]);

    const scheduleOnly = await listRoutines.run({ kind: "schedule" });
    expect(scheduleOnly.routines.map((r) => r.name)).toEqual(["weekday-brief"]);

    const eventOnly = await listRoutines.run({ kind: "event" });
    expect(eventOnly.routines.map((r) => r.name)).toEqual(["on-new-mail"]);
  });

  it("sorts routines by name", async () => {
    store.resourceListAllOwners.mockResolvedValue([
      resource(OWNER, "zeta", schedule()),
      resource(OWNER, "alpha", schedule()),
      resource(OWNER, "mid", schedule()),
    ]);
    const { routines } = await listRoutines.run({});
    expect(routines.map((r) => r.name)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("throws a clear error when unauthenticated", async () => {
    ctx.email = undefined;
    await expect(listRoutines.run({})).rejects.toThrow(
      /no authenticated user/i,
    );
  });
});
