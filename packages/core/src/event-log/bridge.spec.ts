import { describe, expect, it, vi } from "vitest";
import {
  aggregateSourceSubscriptions,
  pollEventBridge,
  type FetchEventLogResult,
  type PollEventBridgeDeps,
} from "./bridge.js";
import { buildTriggerContent } from "../triggers/dispatcher.js";

/** Build a `jobs/*.md` resource string for an event routine. */
function eventRoutine(opts: {
  owner: string;
  path: string;
  event: string;
  sourceApp?: string;
  enabled?: boolean;
  body?: string;
}): { owner: string; path: string; content: string } {
  const content = buildTriggerContent(
    {
      schedule: "",
      enabled: opts.enabled ?? true,
      triggerType: "event",
      event: opts.event,
      sourceApp: opts.sourceApp,
      mode: "agentic",
    },
    opts.body ?? "Do the thing.",
  );
  return { owner: opts.owner, path: opts.path, content };
}

describe("aggregateSourceSubscriptions", () => {
  it("groups enabled cross-app event routines by (sourceApp, owner)", () => {
    const subs = aggregateSourceSubscriptions([
      eventRoutine({
        owner: "alice@example.com",
        path: "jobs/a.md",
        event: "plan.created",
        sourceApp: "plan",
      }),
      eventRoutine({
        owner: "alice@example.com",
        path: "jobs/b.md",
        event: "plan.updated",
        sourceApp: "plan",
      }),
      eventRoutine({
        owner: "bob@example.com",
        path: "jobs/c.md",
        event: "mail.message.received",
        sourceApp: "mail",
      }),
    ]);

    expect(subs).toHaveLength(2);
    const plan = subs.find((s) => s.sourceApp === "plan")!;
    expect(plan.ownerEmail).toBe("alice@example.com");
    expect([...plan.eventNames].sort()).toEqual([
      "plan.created",
      "plan.updated",
    ]);
    const mail = subs.find((s) => s.sourceApp === "mail")!;
    expect(mail.ownerEmail).toBe("bob@example.com");
    expect([...mail.eventNames]).toEqual(["mail.message.received"]);
  });

  it("ignores same-process routines (no sourceApp) and disabled ones", () => {
    const subs = aggregateSourceSubscriptions([
      eventRoutine({
        owner: "alice@example.com",
        path: "jobs/self.md",
        event: "agent.turn.completed",
        // no sourceApp → same-process
      }),
      eventRoutine({
        owner: "alice@example.com",
        path: "jobs/off.md",
        event: "plan.created",
        sourceApp: "plan",
        enabled: false,
      }),
    ]);
    expect(subs).toEqual([]);
  });
});

describe("pollEventBridge", () => {
  function baseDeps(
    overrides: Partial<PollEventBridgeDeps> = {},
  ): PollEventBridgeDeps {
    return {
      listRoutines: async () => [
        eventRoutine({
          owner: "alice@example.com",
          path: "jobs/plan-watch.md",
          event: "plan.created",
          sourceApp: "plan",
        }),
      ],
      discover: async () => [
        { id: "plan", url: "http://plan.test" },
        { id: "mail", url: "http://mail.test" },
      ],
      resolveAuth: async () => ({
        apiKey: "jwt-token",
        userEmail: "alice@example.com",
      }),
      getCursor: async () => 0,
      setCursor: async () => {},
      withOwnerContext: async (_owner, fn) => fn(),
      ...overrides,
    };
  }

  it("pulls a sibling event_log and dispatches matching events, advancing the cursor", async () => {
    const dispatched: Array<{
      name: string;
      sourceApp: string;
      owner?: string;
    }> = [];
    const setCursor = vi.fn(async () => {});
    const fetchEventLog = vi.fn(
      async (
        url: string,
        opts: { since: number; names: string[]; token?: string },
      ): Promise<FetchEventLogResult> => {
        expect(url).toBe("http://plan.test");
        expect(opts.names).toContain("plan.created");
        expect(opts.token).toBe("jwt-token"); // identity passthrough
        expect(opts.since).toBe(0);
        return {
          events: [
            {
              seq: 5,
              name: "plan.created",
              payload: { id: "p1" },
              emittedAt: 1,
            },
            {
              seq: 7,
              name: "plan.created",
              payload: { id: "p2" },
              emittedAt: 2,
            },
          ],
          cursor: 7,
        };
      },
    );

    const result = await pollEventBridge(
      baseDeps({
        fetchEventLog,
        setCursor,
        dispatch: async (name, _payload, eventMeta, sourceApp) => {
          dispatched.push({ name, sourceApp, owner: eventMeta.owner });
        },
      }),
    );

    expect(result.dispatched).toBe(2);
    expect(dispatched).toEqual([
      { name: "plan.created", sourceApp: "plan", owner: "alice@example.com" },
      { name: "plan.created", sourceApp: "plan", owner: "alice@example.com" },
    ]);
    // Cursor advanced to max seq for (plan, alice).
    expect(setCursor).toHaveBeenCalledWith("plan", "alice@example.com", 7);
  });

  it("does not re-dispatch on a second poll once the cursor has advanced (exactly-once)", async () => {
    let stored = 0;
    const dispatch = vi.fn(async () => {});
    const fetchEventLog = vi.fn(
      async (
        _url: string,
        opts: { since: number; names: string[] },
      ): Promise<FetchEventLogResult> => {
        // Server returns only rows with seq > since.
        if (opts.since >= 7) return { events: [], cursor: opts.since };
        return {
          events: [{ seq: 7, name: "plan.created", payload: {}, emittedAt: 1 }],
          cursor: 7,
        };
      },
    );
    const deps = baseDeps({
      fetchEventLog,
      dispatch,
      getCursor: async () => stored,
      setCursor: async (_app, _owner, c) => {
        stored = c;
      },
    });

    await pollEventBridge(deps);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(stored).toBe(7);

    // Second pass resumes from the persisted cursor → nothing new.
    await pollEventBridge(deps);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("isolates a failing source — one unreachable app does not stop the others", async () => {
    const dispatch = vi.fn(async () => {});
    const deps = baseDeps({
      listRoutines: async () => [
        eventRoutine({
          owner: "alice@example.com",
          path: "jobs/plan.md",
          event: "plan.created",
          sourceApp: "plan",
        }),
        eventRoutine({
          owner: "alice@example.com",
          path: "jobs/mail.md",
          event: "mail.message.received",
          sourceApp: "mail",
        }),
      ],
      fetchEventLog: async (url) => {
        if (url === "http://plan.test") throw new Error("plan down");
        return {
          events: [
            {
              seq: 3,
              name: "mail.message.received",
              payload: {},
              emittedAt: 1,
            },
          ],
          cursor: 3,
        };
      },
      dispatch,
    });

    const result = await pollEventBridge(deps);
    // mail still delivered despite plan throwing.
    expect(result.dispatched).toBe(1);
    expect(dispatch).toHaveBeenCalledWith(
      "mail.message.received",
      expect.anything(),
      expect.objectContaining({ owner: "alice@example.com" }),
      "mail",
    );
  });

  it("skips a source app that cannot be discovered (no URL)", async () => {
    const dispatch = vi.fn(async () => {});
    const fetchEventLog = vi.fn();
    const result = await pollEventBridge(
      baseDeps({
        discover: async () => [], // plan not discoverable
        fetchEventLog: fetchEventLog as never,
        dispatch,
      }),
    );
    expect(result.dispatched).toBe(0);
    expect(fetchEventLog).not.toHaveBeenCalled();
  });

  it("does nothing when there are no cross-app subscriptions", async () => {
    const fetchEventLog = vi.fn();
    const result = await pollEventBridge(
      baseDeps({
        listRoutines: async () => [
          eventRoutine({
            owner: "alice@example.com",
            path: "jobs/self.md",
            event: "agent.turn.completed", // no sourceApp
          }),
        ],
        fetchEventLog: fetchEventLog as never,
      }),
    );
    expect(result.dispatched).toBe(0);
    expect(fetchEventLog).not.toHaveBeenCalled();
  });
});
