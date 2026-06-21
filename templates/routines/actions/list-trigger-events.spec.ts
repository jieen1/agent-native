/**
 * list-trigger-events — surfaces the in-process event registry to the event
 * dropdown AND (Phase A3 §1.5.23) aggregates each discovered sibling app's
 * `/events/catalog`, tagging cross-app events with their `sourceApp`.
 *
 * Cross-app aggregation is mocked (§1.5.24): `discoverAgents`,
 * `resolveA2ACallerAuth`, and global `fetch` are stubbed so the test never
 * touches a real sibling app or OAuth.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const discoverAgents = vi.fn();
const resolveA2ACallerAuth = vi.fn();

vi.mock("@agent-native/core/server/agent-discovery", () => ({
  discoverAgents,
}));
vi.mock("@agent-native/core/a2a", () => ({ resolveA2ACallerAuth }));

const { default: listTriggerEvents } = await import("./list-trigger-events.js");

beforeEach(() => {
  discoverAgents.mockReset();
  resolveA2ACallerAuth.mockReset();
  // Default: no sibling apps, no auth.
  discoverAgents.mockResolvedValue([]);
  resolveA2ACallerAuth.mockResolvedValue({ apiKey: undefined });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("list-trigger-events", () => {
  it("lists the in-process built-in events, sorted by name", async () => {
    const { events } = await listTriggerEvents.run({});
    const names = events.map((e) => e.name);

    expect(names).toContain("test.event.fired");
    expect(names).toContain("agent.turn.completed");
    expect([...names]).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("returns a human-readable description and advisory payload keys", async () => {
    const { events } = await listTriggerEvents.run({});
    const turn = events.find((e) => e.name === "agent.turn.completed")!;

    expect(turn).toBeDefined();
    expect(typeof turn.description).toBe("string");
    expect(turn.description.length).toBeGreaterThan(0);
    expect(turn.payloadKeys).toEqual(
      expect.arrayContaining(["threadId", "turnIndex", "model"]),
    );
    // In-process events carry no sourceApp.
    expect(turn.sourceApp).toBeUndefined();
  });

  it("never leaks a non-serializable payload schema object", async () => {
    const { events } = await listTriggerEvents.run({});
    for (const event of events) {
      expect(event).not.toHaveProperty("payloadSchema");
      expect(() => JSON.stringify(event)).not.toThrow();
    }
  });

  it("aggregates sibling app catalogs and tags them with sourceApp", async () => {
    discoverAgents.mockResolvedValue([
      {
        id: "plan",
        name: "Plan",
        description: "",
        url: "http://plan.test",
        color: "#000",
      },
    ]);
    resolveA2ACallerAuth.mockResolvedValue({ apiKey: "jwt-token" });

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: any, init: any) => {
        expect(String(input)).toBe(
          "http://plan.test/_agent-native/events/catalog",
        );
        // Identity passthrough: the A2A JWT must be sent.
        expect(init?.headers?.authorization).toBe("Bearer jwt-token");
        return {
          ok: true,
          json: async () => ({
            events: [
              { name: "plan.created", description: "A plan was created" },
            ],
          }),
        } as Response;
      });

    const { events } = await listTriggerEvents.run({});
    fetchSpy.mockRestore();

    const planEvent = events.find((e) => e.name === "plan.created")!;
    expect(planEvent).toBeDefined();
    expect(planEvent.sourceApp).toBe("plan");
    // Description carries the source-app annotation for the dropdown.
    expect(planEvent.description).toContain("(plan)");
    // In-process events are still present.
    expect(events.map((e) => e.name)).toContain("agent.turn.completed");
    // Result is JSON-serializable end to end.
    expect(() => JSON.stringify(events)).not.toThrow();
  });

  it("does not fail the whole list when a sibling app is unreachable", async () => {
    discoverAgents.mockResolvedValue([
      {
        id: "plan",
        name: "Plan",
        description: "",
        url: "http://plan.test",
        color: "#000",
      },
      {
        id: "mail",
        name: "Mail",
        description: "",
        url: "http://mail.test",
        color: "#000",
      },
    ]);
    resolveA2ACallerAuth.mockResolvedValue({ apiKey: "jwt-token" });

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: any) => {
        if (String(input).startsWith("http://plan.test")) {
          throw new Error("plan down");
        }
        return {
          ok: true,
          json: async () => ({
            events: [
              { name: "mail.message.received", description: "New mail" },
            ],
          }),
        } as Response;
      });

    const { events } = await listTriggerEvents.run({});
    fetchSpy.mockRestore();

    const names = events.map((e) => e.name);
    // mail still aggregated despite plan throwing; in-process events intact.
    expect(names).toContain("mail.message.received");
    expect(names).toContain("agent.turn.completed");
    expect(names).not.toContain("plan.created");
  });

  it("in-process event wins on a name collision with a sibling catalog", async () => {
    discoverAgents.mockResolvedValue([
      {
        id: "ghost",
        name: "Ghost",
        description: "",
        url: "http://ghost.test",
        color: "#000",
      },
    ]);
    resolveA2ACallerAuth.mockResolvedValue({ apiKey: "jwt-token" });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        events: [
          // Collides with a built-in in-process event.
          { name: "agent.turn.completed", description: "ghost copy" },
        ],
      }),
    } as Response);

    const { events } = await listTriggerEvents.run({});
    fetchSpy.mockRestore();

    const turn = events.filter((e) => e.name === "agent.turn.completed");
    expect(turn).toHaveLength(1);
    // The in-process one (no sourceApp) wins.
    expect(turn[0].sourceApp).toBeUndefined();
  });
});
