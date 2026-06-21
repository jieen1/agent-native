import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Intercept the durable sink's dynamic `import("../event-log/store.js")` so we
// can assert emit() appends to event_log AFTER in-process dispatch without a
// real database. The sink is fire-and-forget, so the test awaits microtasks.
const appendEventLog = vi.fn(async () => {});
vi.mock("../event-log/store.js", () => ({ appendEventLog }));

const { __resetEventBus, emit, subscribe } = await import("./bus.js");
const { __resetEventRegistry, registerEvent } = await import("./registry.js");

/**
 * Let the durable sink's dynamic `import().then()` chain settle. A dynamic
 * import resolves on the microtask queue but can need several ticks; loop a few
 * macrotasks to be safe without depending on an exact tick count.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("event-bus durable sink (Phase A3 §1.5.23)", () => {
  beforeEach(() => {
    __resetEventBus();
    __resetEventRegistry();
    appendEventLog.mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    __resetEventBus();
    __resetEventRegistry();
    vi.restoreAllMocks();
  });

  it("emit stays synchronous and dispatches in-process before the sink runs", async () => {
    registerEvent({
      name: "thing.happened",
      description: "test",
      payloadSchema: (await import("zod")).z.object({
        n: (await import("zod")).z.number(),
      }) as any,
    });
    const handler = vi.fn();
    subscribe("thing.happened", handler);

    // emit() returns void synchronously; the in-process handler has already run.
    const ret = emit(
      "thing.happened",
      { n: 42 },
      { owner: "alice@example.com" },
    );
    expect(ret).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);

    // The sink is fire-and-forget via a dynamic import() — let the import
    // promise and its .then() chain settle across several ticks.
    await flushMicrotasks();

    expect(appendEventLog).toHaveBeenCalledTimes(1);
    const arg = appendEventLog.mock.calls[0][0] as {
      name: string;
      ownerEmail?: string;
      payloadJson: string;
      emittedAt: number;
      id: string;
    };
    expect(arg.name).toBe("thing.happened");
    expect(arg.ownerEmail).toBe("alice@example.com");
    expect(JSON.parse(arg.payloadJson)).toEqual({ n: 42 });
    expect(typeof arg.id).toBe("string");
    expect(arg.id.length).toBeGreaterThan(0);
    expect(typeof arg.emittedAt).toBe("number");
  });

  it("does not append when payload validation fails (no dispatch, no sink)", async () => {
    const { z } = await import("zod");
    registerEvent({
      name: "strict.event",
      description: "test",
      payloadSchema: z.object({ n: z.number() }) as any,
    });
    const handler = vi.fn();
    subscribe("strict.event", handler);

    emit("strict.event", { n: "not-a-number" });

    await flushMicrotasks();

    expect(handler).not.toHaveBeenCalled();
    expect(appendEventLog).not.toHaveBeenCalled();
  });

  it("a throwing sink never breaks emit or in-process dispatch", async () => {
    appendEventLog.mockRejectedValueOnce(new Error("db down"));
    const handler = vi.fn();
    subscribe("unregistered.event", handler);

    expect(() => emit("unregistered.event", { ok: true })).not.toThrow();
    expect(handler).toHaveBeenCalledTimes(1);

    await flushMicrotasks();
    // The rejection was swallowed by the sink's .catch — no unhandled rejection.
    expect(appendEventLog).toHaveBeenCalledTimes(1);
  });
});
