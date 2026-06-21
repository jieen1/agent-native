/**
 * Phase B2 acceptance tests for `runFanout` (docs/IMPLEMENTATION_PLAN.md
 * §1.5.6 / §1.5.18 / §1.5.24). OAuth is NOT required: the A2A invoke is
 * injected, so we assert orchestration semantics with mocked sibling replies.
 *
 * Coverage:
 *   - parallel wall-clock (allSettled, not serial)
 *   - identity passthrough (apiKey + userEmail from resolveAuth reach invoke)
 *   - per-leg timeout    -> status:"timeout"
 *   - thrown error       -> status:"error" + error
 *   - partial failure    -> one leg "ok", one leg "error" in the same run
 *   - ok reply           -> status:"ok" + responseText, latencyMs measured
 *   - over-cap reply     -> responseText truncated + marked
 *   - deep links         -> ok leg's app-scoped links extracted into deepLinks
 *   - self-call guard via the REAL invokeAgent: the self leg is "skipped"
 *     (never invoked) and the network edge fires only targets.length - 1 times.
 */
import { describe, expect, it, vi } from "vitest";
import { runFanout } from "./fanout.js";
import { MAX_PER_SOURCE_CHARS, TRUNCATION_MARKER } from "./limits.js";
import {
  invokeAgent,
  type AgentInvocationResult,
} from "@agent-native/core/a2a";
import type { DiscoveredAgent } from "@agent-native/core/server/agent-discovery";

function agent(id: string, port: number): DiscoveredAgent {
  return {
    id,
    name: id,
    description: "",
    url: `http://localhost:${port}`,
    color: "#000",
  };
}

const fakeAuth = async () => ({
  apiKey: "jwt-token",
  userEmail: "u@example.com",
  orgId: undefined,
  orgDomain: undefined,
  orgSecret: undefined,
  metadata: {},
});

function okResult(target: string, text: string): AgentInvocationResult {
  return {
    target: {
      kind: "discovered",
      id: target,
      name: target,
      url: `http://localhost/${target}`,
    },
    prompt: `sent ${target}`,
    responseText: text,
  };
}

describe("runFanout — parallelism", () => {
  it("runs all legs in parallel (wall-clock ~ slowest leg, not the sum)", async () => {
    const invoke = vi.fn(async (o: { target: string }) => {
      await new Promise((r) => setTimeout(r, 200));
      return okResult(o.target, `reply ${o.target}`);
    });
    const started = Date.now();
    const sources = await runFanout({
      selfAppId: "chief-of-staff",
      targets: [agent("mail", 8110), agent("calendar", 8111)],
      buildPrompt: (id) => `ping ${id}`,
      perAppTimeoutMs: 35_000,
      invoke: invoke as unknown as typeof invokeAgent,
      resolveAuth: fakeAuth,
    });
    const elapsed = Date.now() - started;
    expect(sources).toHaveLength(2);
    expect(sources.every((s) => s.status === "ok")).toBe(true);
    expect(elapsed).toBeLessThan(400); // serial would be ~400ms+
  });
});

describe("runFanout — identity passthrough", () => {
  it("forwards the resolved apiKey + userEmail and selfAppId to every leg", async () => {
    const invoke = vi.fn(async (o: { target: string }) =>
      okResult(o.target, "ok"),
    );
    await runFanout({
      selfAppId: "chief-of-staff",
      targets: [agent("mail", 8110)],
      buildPrompt: (id) => `ping ${id}`,
      perAppTimeoutMs: 35_000,
      invoke: invoke as unknown as typeof invokeAgent,
      resolveAuth: fakeAuth,
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][0]).toMatchObject({
      target: "mail",
      selfAppId: "chief-of-staff",
      apiKey: "jwt-token",
      userEmail: "u@example.com",
      async: true,
    });
  });
});

describe("runFanout — per-leg outcomes", () => {
  it("maps a slow leg past perAppTimeoutMs to status:'timeout'", async () => {
    const invoke = vi.fn(async (o: { target: string }) => {
      if (o.target === "calendar") {
        await new Promise((r) => setTimeout(r, 200));
      }
      return okResult(o.target, "ok");
    });
    const sources = await runFanout({
      selfAppId: "chief-of-staff",
      targets: [agent("mail", 8110), agent("calendar", 8111)],
      buildPrompt: (id) => `ping ${id}`,
      perAppTimeoutMs: 50,
      invoke: invoke as unknown as typeof invokeAgent,
      resolveAuth: fakeAuth,
    });
    const byApp = Object.fromEntries(sources.map((s) => [s.app, s]));
    expect(byApp.mail.status).toBe("ok");
    expect(byApp.calendar.status).toBe("timeout");
    expect(byApp.calendar.error).toMatch(/timed out/i);
  });

  it("maps a thrown leg to status:'error' with the message", async () => {
    const invoke = vi.fn(async (o: { target: string }) => {
      if (o.target === "calendar") throw new Error("calendar down");
      return okResult(o.target, "ok");
    });
    const sources = await runFanout({
      selfAppId: "chief-of-staff",
      targets: [agent("mail", 8110), agent("calendar", 8111)],
      buildPrompt: (id) => `ping ${id}`,
      perAppTimeoutMs: 35_000,
      invoke: invoke as unknown as typeof invokeAgent,
      resolveAuth: fakeAuth,
    });
    const byApp = Object.fromEntries(sources.map((s) => [s.app, s]));
    expect(byApp.mail.status).toBe("ok");
    expect(byApp.calendar.status).toBe("error");
    expect(byApp.calendar.error).toContain("calendar down");
  });

  it("records responseText and a measured latency for an ok leg", async () => {
    const invoke = vi.fn(async (o: { target: string }) => {
      await new Promise((r) => setTimeout(r, 20));
      return okResult(o.target, "reply text");
    });
    const [s] = await runFanout({
      selfAppId: "chief-of-staff",
      targets: [agent("mail", 8110)],
      buildPrompt: (id) => `ping ${id}`,
      perAppTimeoutMs: 35_000,
      invoke: invoke as unknown as typeof invokeAgent,
      resolveAuth: fakeAuth,
    });
    expect(s.responseText).toBe("reply text");
    expect(s.latencyMs).toBeGreaterThanOrEqual(0);
    expect(s.prompt).toBe("ping mail");
  });

  it("truncates an over-cap responseText and appends the marker", async () => {
    const big = "y".repeat(MAX_PER_SOURCE_CHARS + 5_000);
    const invoke = vi.fn(async (o: { target: string }) =>
      okResult(o.target, big),
    );
    const [s] = await runFanout({
      selfAppId: "chief-of-staff",
      targets: [agent("mail", 8110)],
      buildPrompt: (id) => `ping ${id}`,
      perAppTimeoutMs: 35_000,
      invoke: invoke as unknown as typeof invokeAgent,
      resolveAuth: fakeAuth,
    });
    expect(s.responseText.length).toBe(
      MAX_PER_SOURCE_CHARS + TRUNCATION_MARKER.length,
    );
    expect(s.responseText.endsWith(TRUNCATION_MARKER)).toBe(true);
  });
});

describe("runFanout — partial failure", () => {
  it("one leg ok and one leg error in the same run (§B2 partial)", async () => {
    const invoke = vi.fn(async (o: { target: string }) => {
      if (o.target === "calendar") throw new Error("calendar down");
      return okResult(o.target, "mail reply");
    });
    const sources = await runFanout({
      selfAppId: "chief-of-staff",
      targets: [agent("mail", 8110), agent("calendar", 8111)],
      buildPrompt: (id) => `ping ${id}`,
      perAppTimeoutMs: 35_000,
      invoke: invoke as unknown as typeof invokeAgent,
      resolveAuth: fakeAuth,
    });
    const byApp = Object.fromEntries(sources.map((s) => [s.app, s]));
    // The failing leg never aborts the healthy one (allSettled).
    expect(byApp.mail.status).toBe("ok");
    expect(byApp.mail.responseText).toBe("mail reply");
    expect(byApp.calendar.status).toBe("error");
    expect(byApp.calendar.error).toContain("calendar down");
    // A mix of ok + error is exactly what compile-briefing folds to "partial".
    const okCount = sources.filter((s) => s.status === "ok").length;
    expect(okCount).toBe(1);
    expect(okCount).toBeLessThan(sources.length);
  });
});

describe("runFanout — deep links (§1.5.12)", () => {
  it("extracts app-scoped deep links from an ok leg and drops off-origin links", async () => {
    const reply =
      "Reply to Dana: [open](http://localhost:8110/threads/abc). " +
      "Ignore this calendar link http://localhost:8111/events/9 and this " +
      "external one https://evil.example.com/x.";
    const invoke = vi.fn(async (o: { target: string }) =>
      okResult(o.target, reply),
    );
    const [s] = await runFanout({
      selfAppId: "chief-of-staff",
      targets: [agent("mail", 8110)],
      buildPrompt: (id) => `ping ${id}`,
      perAppTimeoutMs: 35_000,
      invoke: invoke as unknown as typeof invokeAgent,
      resolveAuth: fakeAuth,
    });
    expect(s.status).toBe("ok");
    expect(s.deepLinks).toEqual(["http://localhost:8110/threads/abc"]);
  });

  it("leaves deepLinks empty when the reply has no app-scoped links", async () => {
    const invoke = vi.fn(async (o: { target: string }) =>
      okResult(o.target, "Nothing needs you in mail today."),
    );
    const [s] = await runFanout({
      selfAppId: "chief-of-staff",
      targets: [agent("mail", 8110)],
      buildPrompt: (id) => `ping ${id}`,
      perAppTimeoutMs: 35_000,
      invoke: invoke as unknown as typeof invokeAgent,
      resolveAuth: fakeAuth,
    });
    expect(s.status).toBe("ok");
    expect(s.deepLinks).toEqual([]);
  });
});

describe("runFanout — self-call guard (REAL invokeAgent)", () => {
  it("self target → status:'skipped' via real self-call guard; other legs run, callAgent fires n-1 times", async () => {
    // Use the REAL invokeAgent. The self target ("chief-of-staff" === selfAppId)
    // is rejected by the guard (invoke.ts:107-111) BEFORE any network call, so
    // its leg never reaches `callAgent`. We spy on `callAgent` (the network
    // edge) and assert it ran exactly targets.length - 1 times — the self leg
    // is short-circuited (§1.5.18 "不死循环").
    const callAgent = vi.fn(async (url: string) => `reply from ${url}`);
    const targets = [
      agent("chief-of-staff", 8115), // self — guarded, never invoked
      agent("mail", 8110),
      agent("calendar", 8111),
    ];

    const sources = await runFanout({
      selfAppId: "chief-of-staff",
      targets,
      buildPrompt: (id) => `ping ${id}`,
      perAppTimeoutMs: 200,
      // Real invoke, but inject a runtime so non-self legs resolve without a
      // real network: findAgent returns the known sibling, callAgent is the spy.
      invoke: ((opts) =>
        invokeAgent({
          ...opts,
          runtime: {
            findAgent: async (idOrName: string) => {
              const t = targets.find((a) => a.id === idOrName);
              return t ?? undefined;
            },
            discoverAgents: async () => targets,
            callAgent,
          },
        })) as typeof invokeAgent,
      resolveAuth: fakeAuth,
    });

    const byApp = Object.fromEntries(sources.map((s) => [s.app, s]));
    // Self leg is skipped (not error, not data) and tagged self-call.
    expect(byApp["chief-of-staff"].status).toBe("skipped");
    expect(byApp["chief-of-staff"].error).toContain("self-call");
    expect(byApp["chief-of-staff"].responseText).toBe("");
    // The two real legs went through the real invoke path and succeeded.
    expect(byApp.mail.status).toBe("ok");
    expect(byApp.calendar.status).toBe("ok");
    // Network edge fired only for the non-self legs: targets.length - 1.
    expect(callAgent).toHaveBeenCalledTimes(targets.length - 1);
    const calledUrls = callAgent.mock.calls.map((c) => c[0]);
    expect(calledUrls).not.toContain("http://localhost:8115");
  });
});
