/**
 * event-log HTTP handlers — identity gate + owner scope (Phase A3 §1.5.23).
 *
 * `store.spec.ts` proves `readEventLog` is owner-scoped at the SQL level. This
 * spec proves the OTHER half of acceptance #3 — the HTTP handler resolves the
 * caller's identity (session cookie, else A2A Bearer JWT), passes THAT email
 * (and nothing the caller can spoof via query) to `readEventLog`, and rejects
 * an unauthenticated request with 401. Concretely:
 *
 *   - a session cookie → owner = session.email; readEventLog scoped to it.
 *   - an A2A Bearer JWT (the cross-app poller's path) → owner = verified `sub`
 *     email; a forged/garbage token verifies to nothing → 401.
 *   - no identity → 401, and the store is never queried (no leak).
 *   - `since` / `names` / `limit` are parsed and forwarded; the owner is taken
 *     from the verified identity, never from the request, so user A cannot read
 *     user B's events by passing B's address.
 *   - the catalog handler is gated by the same identity check (no anonymous
 *     cross-bridge catalog reads).
 *
 * Auth + store seams are mocked (§1.5.24) so no DB / real A2A secret is needed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSession = vi.fn();
const mockVerifyA2AToken = vi.fn();
const mockReadEventLog = vi.fn();
const mockListEvents = vi.fn();

let lastStatus = 200;

vi.mock("h3", () => ({
  defineEventHandler: (handler: any) => handler,
  getMethod: (event: any) => event._method ?? "GET",
  getQuery: (event: any) => event._query ?? {},
  getHeader: (event: any, name: string) => event._headers?.[name.toLowerCase()],
  setResponseStatus: (_event: any, code: number) => {
    lastStatus = code;
  },
  createError: (opts: { statusCode: number; statusMessage?: string }) => {
    const err = new Error(opts.statusMessage ?? "error") as Error & {
      statusCode: number;
    };
    err.statusCode = opts.statusCode;
    return err;
  },
}));

vi.mock("../server/auth.js", () => ({
  getSession: (...args: any[]) => mockGetSession(...args),
}));

vi.mock("../a2a/server.js", () => ({
  verifyA2AToken: (...args: any[]) => mockVerifyA2AToken(...args),
}));

vi.mock("../event-bus/index.js", () => ({
  listEvents: (...args: any[]) => mockListEvents(...args),
}));

vi.mock("./store.js", () => ({
  readEventLog: (...args: any[]) => mockReadEventLog(...args),
}));

const { createEventLogHandler, createEventsCatalogHandler } =
  await import("./routes.js");

interface FakeEvent {
  _method?: string;
  _query?: Record<string, unknown>;
  _headers?: Record<string, string>;
}

function ev(opts: FakeEvent = {}): any {
  return {
    _method: opts._method ?? "GET",
    _query: opts._query ?? {},
    _headers: opts._headers ?? {},
  };
}

describe("event-log route — identity gate + owner scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastStatus = 200;
    mockGetSession.mockResolvedValue(null);
    mockVerifyA2AToken.mockResolvedValue({ email: undefined });
    mockReadEventLog.mockResolvedValue({ events: [], cursor: 0 });
    mockListEvents.mockReturnValue([]);
  });

  it("scopes the read to the authenticated SESSION email, not anything in the query", async () => {
    mockGetSession.mockResolvedValue({ email: "alice@example.com" });
    mockReadEventLog.mockResolvedValue({
      events: [
        { seq: 5, name: "plan.created", payload: { id: "p1" }, emittedAt: 1 },
      ],
      cursor: 5,
    });

    const handler = createEventLogHandler();
    const result = await handler(
      // A spoof attempt: caller tries to read bob's events via the query.
      ev({
        _query: { since: "3", names: "plan.created", owner: "bob@example.com" },
      }),
    );

    // Owner is the verified session email — bob's address in the query is ignored.
    expect(mockReadEventLog).toHaveBeenCalledTimes(1);
    expect(mockReadEventLog.mock.calls[0][0]).toBe("alice@example.com");
    expect(mockReadEventLog.mock.calls[0][1]).toMatchObject({
      since: 3,
      names: ["plan.created"],
    });
    expect(result).toEqual({
      events: [
        { seq: 5, name: "plan.created", payload: { id: "p1" }, emittedAt: 1 },
      ],
      cursor: 5,
    });
  });

  it("resolves identity from an A2A Bearer JWT when there is no session (the cross-app poller path)", async () => {
    mockGetSession.mockResolvedValue(null);
    mockVerifyA2AToken.mockResolvedValue({ email: "carol@example.com" });

    const handler = createEventLogHandler();
    await handler(
      ev({ _headers: { authorization: "Bearer signed.jwt.here" } }),
    );

    expect(mockVerifyA2AToken).toHaveBeenCalledWith(
      "signed.jwt.here",
      expect.anything(),
    );
    // Read scoped to the verified JWT subject.
    expect(mockReadEventLog).toHaveBeenCalledTimes(1);
    expect(mockReadEventLog.mock.calls[0][0]).toBe("carol@example.com");
  });

  it("401s and never queries the store when no identity can be resolved", async () => {
    mockGetSession.mockResolvedValue(null);
    const handler = createEventLogHandler();

    await expect(handler(ev())).rejects.toMatchObject({ statusCode: 401 });
    expect(mockReadEventLog).not.toHaveBeenCalled();
  });

  it("401s when a Bearer token is present but verifies to no identity (forged/expired)", async () => {
    mockGetSession.mockResolvedValue(null);
    mockVerifyA2AToken.mockRejectedValue(new Error("bad signature"));

    const handler = createEventLogHandler();
    await expect(
      handler(ev({ _headers: { authorization: "Bearer forged" } })),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(mockReadEventLog).not.toHaveBeenCalled();
  });

  it("session takes precedence over a Bearer header", async () => {
    mockGetSession.mockResolvedValue({ email: "alice@example.com" });
    mockVerifyA2AToken.mockResolvedValue({ email: "carol@example.com" });

    const handler = createEventLogHandler();
    await handler(ev({ _headers: { authorization: "Bearer carol.jwt" } }));

    expect(mockVerifyA2AToken).not.toHaveBeenCalled();
    expect(mockReadEventLog.mock.calls[0][0]).toBe("alice@example.com");
  });

  it("rejects non-GET methods with 405 without touching the store", async () => {
    mockGetSession.mockResolvedValue({ email: "alice@example.com" });
    const handler = createEventLogHandler();
    const result = await handler(ev({ _method: "POST" }));
    expect(lastStatus).toBe(405);
    expect(mockReadEventLog).not.toHaveBeenCalled();
    expect(result).toMatchObject({ error: expect.any(String) });
  });
});

describe("events/catalog route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastStatus = 200;
    mockGetSession.mockResolvedValue(null);
    mockListEvents.mockReturnValue([]);
  });

  it("returns the in-process registry (name + description only) for an authenticated caller", async () => {
    mockGetSession.mockResolvedValue({ email: "alice@example.com" });
    mockListEvents.mockReturnValue([
      {
        name: "plan.created",
        description: "A plan was created",
        // A non-serializable schema must NOT leak into the response.
        payloadSchema: { not: "serializable" },
      },
    ]);

    const handler = createEventsCatalogHandler();
    const result = await handler(ev());

    expect(result).toEqual({
      events: [{ name: "plan.created", description: "A plan was created" }],
    });
    expect(result.events[0]).not.toHaveProperty("payloadSchema");
  });

  it("401s an unauthenticated catalog read (no anonymous cross-bridge reads)", async () => {
    mockGetSession.mockResolvedValue(null);
    const handler = createEventsCatalogHandler();
    await expect(handler(ev())).rejects.toMatchObject({ statusCode: 401 });
    expect(mockListEvents).not.toHaveBeenCalled();
  });
});
