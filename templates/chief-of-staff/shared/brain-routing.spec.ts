/**
 * Phase B3 tests for brain-driven second-level routing
 * (docs/CHIEF_OF_STAFF_DESIGN.md §6 / docs/IMPLEMENTATION_PLAN.md §12). OAuth is
 * NOT required (§1.5.24): the A2A invoke + auth are injected, so we drive the
 * routing with stubbed brain replies.
 *
 * Coverage:
 *   - parseDelegationAppIds: raw JSON array, prose-wrapped JSON, ```json fence,
 *     malformed input, dedupe, non-string/missing appId.
 *   - routeViaBrain: suggested appIds ∩ discovered − alreadyWanted − self/brain,
 *     identity passthrough into invoke, first-seen ordering.
 *   - failure is non-fatal: a thrown brain leg yields { targets: [], error }.
 */
import { describe, expect, it, vi } from "vitest";
import {
  parseDelegationAppIds,
  routeViaBrain,
  buildBrainRoutePrompt,
} from "./brain-routing.js";
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

function reply(text: string): AgentInvocationResult {
  return {
    target: { kind: "discovered", id: "brain", name: "brain", url: "http://x" },
    prompt: "p",
    responseText: text,
  };
}

describe("parseDelegationAppIds", () => {
  it("parses a raw JSON array of hints", () => {
    const text = JSON.stringify([
      { appId: "analytics", matchedSignals: ["dashboard"] },
      { appId: "mail", matchedSignals: ["inbox"] },
    ]);
    expect(parseDelegationAppIds(text)).toEqual(["analytics", "mail"]);
  });

  it("extracts JSON embedded in prose", () => {
    const text =
      'Here are the hints I found:\n[{"appId":"analytics","matchedSignals":["kpi"]}]\nHope that helps.';
    expect(parseDelegationAppIds(text)).toEqual(["analytics"]);
  });

  it("extracts JSON from a ```json fence", () => {
    const text =
      '```json\n[{ "appId": "dispatch", "matchedSignals": ["grant"] }]\n```';
    expect(parseDelegationAppIds(text)).toEqual(["dispatch"]);
  });

  it("de-dupes and drops entries without a string appId", () => {
    const text = JSON.stringify([
      { appId: "analytics" },
      { appId: "analytics" },
      { matchedSignals: ["x"] },
      { appId: 42 },
      { appId: "  mail  " },
    ]);
    expect(parseDelegationAppIds(text)).toEqual(["analytics", "mail"]);
  });

  it("returns [] for an empty array, no array, or malformed JSON", () => {
    expect(parseDelegationAppIds("[]")).toEqual([]);
    expect(parseDelegationAppIds("no json here")).toEqual([]);
    expect(parseDelegationAppIds("[{ broken")).toEqual([]);
  });
});

describe("routeViaBrain — target resolution", () => {
  it("resolves suggested appIds ∩ discovered − alreadyWanted (§12)", async () => {
    // Brain suggests analytics (the §12 acceptance case) + mail.
    const invoke = vi.fn(async () =>
      reply(
        JSON.stringify([
          { appId: "analytics", matchedSignals: ["dashboard"] },
          { appId: "mail", matchedSignals: ["inbox"] },
        ]),
      ),
    );
    const res = await routeViaBrain({
      selfAppId: "chief-of-staff",
      focus: "revenue dashboard",
      discovered: [
        agent("mail", 8110),
        agent("calendar", 8111),
        agent("brain", 8112),
        agent("analytics", 8113),
      ],
      // mail is already a first-level target; analytics is not.
      alreadyWanted: ["mail", "calendar", "brain"],
      invoke: invoke as unknown as typeof invokeAgent,
      resolveAuth: fakeAuth,
    });

    // mail excluded (already wanted); analytics kept (discovered + not wanted).
    expect(res.targets.map((t) => t.id)).toEqual(["analytics"]);
    expect(res.suggestedAppIds).toEqual(["analytics", "mail"]);
    expect(res.error).toBeUndefined();
  });

  it("drops suggested apps that were not discovered", async () => {
    const invoke = vi.fn(async () =>
      reply(JSON.stringify([{ appId: "dispatch" }])),
    );
    const res = await routeViaBrain({
      selfAppId: "chief-of-staff",
      focus: "approvals",
      discovered: [agent("mail", 8110), agent("brain", 8112)], // no dispatch
      alreadyWanted: ["mail", "brain"],
      invoke: invoke as unknown as typeof invokeAgent,
      resolveAuth: fakeAuth,
    });
    expect(res.targets).toEqual([]);
    expect(res.suggestedAppIds).toEqual(["dispatch"]);
  });

  it("never routes back to brain or to self", async () => {
    const invoke = vi.fn(async () =>
      reply(JSON.stringify([{ appId: "brain" }, { appId: "chief-of-staff" }])),
    );
    const res = await routeViaBrain({
      selfAppId: "chief-of-staff",
      focus: "anything",
      discovered: [agent("brain", 8112), agent("chief-of-staff", 8100)],
      alreadyWanted: ["brain"],
      invoke: invoke as unknown as typeof invokeAgent,
      resolveAuth: fakeAuth,
    });
    expect(res.targets).toEqual([]);
  });

  it("forwards the resolved auth + selfAppId into the brain invoke", async () => {
    const invoke = vi.fn(async (_o: Record<string, unknown>) => reply("[]"));
    await routeViaBrain({
      selfAppId: "chief-of-staff",
      focus: "today",
      discovered: [agent("brain", 8112)],
      alreadyWanted: ["brain"],
      invoke: invoke as unknown as typeof invokeAgent,
      resolveAuth: fakeAuth,
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    const opts = invoke.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.target).toBe("brain");
    expect(opts.selfAppId).toBe("chief-of-staff");
    expect(opts.apiKey).toBe("jwt-token");
    expect(opts.userEmail).toBe("u@example.com");
    expect(opts.prompt).toBe(buildBrainRoutePrompt("today"));
  });
});

describe("routeViaBrain — failure is non-fatal", () => {
  it("returns { targets: [], error } when the brain leg throws (never rethrows)", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("brain unreachable");
    });
    const res = await routeViaBrain({
      selfAppId: "chief-of-staff",
      focus: "x",
      discovered: [agent("brain", 8112), agent("analytics", 8113)],
      alreadyWanted: ["brain"],
      invoke: invoke as unknown as typeof invokeAgent,
      resolveAuth: fakeAuth,
    });
    expect(res.targets).toEqual([]);
    expect(res.error).toMatch(/brain unreachable/);
  });
});
