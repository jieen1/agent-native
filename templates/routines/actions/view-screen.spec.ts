/**
 * view-screen — Phase A5 production gate §1.5.20 item 3: "view-screen returns a
 * structured snapshot consistent with application_state".
 *
 * Asserts the structure of the snapshot (not any prose):
 *   - `screen` is read from application_state navigation (defaults to "chat").
 *   - `navigation` echoes the raw navigation app-state object.
 *   - `routines` is the current owner's routines (schedule + event kinds), so a
 *     just-forked routine shows up here (the fork → view-screen consistency the
 *     A5 acceptance asks for).
 *   - `editingRoutineName` is pulled from the navigation state when present.
 *   - empty/unauthenticated state degrades to an empty routine list without
 *     throwing (§1.5.19 robustness).
 *
 * `@agent-native/core/application-state`, `resources/store`, and the
 * request-context are mocked; the real `_routines-lib` + `triggers` parse the
 * resources, so the snapshot reflects genuine routine view-models.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTriggerContent,
  type TriggerFrontmatter,
} from "@agent-native/core/triggers";

const OWNER = "owner@example.com";

const appState = vi.hoisted(() => ({
  readAppState: vi.fn(),
}));
const store = vi.hoisted(() => ({
  resourceListAllOwners: vi.fn(),
}));
const ctx = vi.hoisted(() => ({
  email: "owner@example.com" as string | undefined,
}));

vi.mock("@agent-native/core/application-state", () => ({
  readAppState: appState.readAppState,
}));
vi.mock("@agent-native/core/resources/store", () => ({
  resourceListAllOwners: store.resourceListAllOwners,
}));
vi.mock("@agent-native/core/server/request-context", () => ({
  getRequestUserEmail: () => ctx.email,
  getRequestOrgId: () => undefined,
}));

const { default: viewScreen } = await import("./view-screen.js");

function resource(name: string, meta: TriggerFrontmatter) {
  return {
    id: `res_${name}`,
    owner: OWNER,
    path: `jobs/${name}.md`,
    content: buildTriggerContent(meta, "do it"),
    updatedAt: new Date("2026-06-21T00:00:00.000Z"),
  };
}

const schedule: TriggerFrontmatter = {
  schedule: "30 8 * * 1-5",
  enabled: true,
  triggerType: "schedule",
  mode: "agentic",
};

describe("view-screen returns a structured snapshot consistent with app-state", () => {
  beforeEach(() => {
    appState.readAppState.mockReset();
    store.resourceListAllOwners.mockReset();
    ctx.email = OWNER;
    store.resourceListAllOwners.mockResolvedValue([]);
  });

  it("echoes navigation, derives the screen, and lists the owner's routines", async () => {
    appState.readAppState.mockResolvedValue({
      screen: "routine-edit",
      routineName: "daily-briefing",
      path: "/routines/daily-briefing",
    });
    store.resourceListAllOwners.mockResolvedValue([
      resource("daily-briefing", schedule),
    ]);

    const result = await viewScreen.run({});

    // Structured shape, consistent with the navigation app-state.
    expect(result.screen).toBe("routine-edit");
    expect(result.navigation).toMatchObject({
      screen: "routine-edit",
      routineName: "daily-briefing",
    });
    expect(result.editingRoutineName).toBe("daily-briefing");

    // The owner's routine (e.g. a just-forked one) appears in the snapshot.
    expect(result.routines).toHaveLength(1);
    expect(result.routines[0]).toMatchObject({
      name: "daily-briefing",
      kind: "schedule",
      schedule: "30 8 * * 1-5",
    });
  });

  it("defaults screen to 'chat' and editingRoutineName to undefined with no navigation", async () => {
    appState.readAppState.mockResolvedValue(null);

    const result = await viewScreen.run({});

    expect(result.screen).toBe("chat");
    expect(result.navigation).toBeNull();
    expect(result.editingRoutineName).toBeUndefined();
    expect(result.routines).toEqual([]);
  });

  it("a forked routine becomes visible in the snapshot's routine list", async () => {
    // Simulate state right after fork-routine wrote jobs/pr-recap-on-plan.md.
    appState.readAppState.mockResolvedValue({ screen: "routines" });
    store.resourceListAllOwners.mockResolvedValue([
      resource("pr-recap-on-plan", {
        schedule: "",
        enabled: true,
        triggerType: "event",
        mode: "agentic",
        event: "plan.created",
        sourceApp: "plan",
        condition: "the plan is a merged-PR recap",
      }),
    ]);

    const { routines } = await viewScreen.run({});
    const recap = routines.find((r) => r.name === "pr-recap-on-plan");
    expect(recap).toBeDefined();
    expect(recap?.kind).toBe("event");
    expect(recap?.event).toBe("plan.created");
    expect(recap?.sourceApp).toBe("plan");
  });

  it("degrades to an empty routine list when unauthenticated (no throw)", async () => {
    appState.readAppState.mockResolvedValue({ screen: "routines" });
    ctx.email = undefined;

    const result = await viewScreen.run({});

    expect(result.screen).toBe("routines");
    expect(result.routines).toEqual([]);
  });

  it("swallows a listing failure and still returns a structured snapshot (empty list)", async () => {
    appState.readAppState.mockResolvedValue({ screen: "routines" });
    store.resourceListAllOwners.mockRejectedValue(new Error("no db context"));

    const result = await viewScreen.run({});

    expect(result.screen).toBe("routines");
    expect(result.routines).toEqual([]);
  });
});
