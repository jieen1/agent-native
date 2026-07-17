// F9 (orchestrator half) — tracker-client.ts unit tests.
//
// These exercise the writeback channel's own mechanics in isolation from the
// reconciler: JWT minting (sentinel identity + org_id claim), the MCP
// tools/call transport (via a mocked global fetch — a "mock A2A client" in
// the sense the delivery report uses that phrase: we assert on the exact
// request shape a real tracker MCP endpoint would receive, without standing
// up a real tracker), tag parsing, delivery-text extraction, and the retry
// backoff helper.
//
// Real end-to-end (an actual tracker container reachable over the network,
// verifying its DB rows change) is NOT exercised here — see the delivery
// report for what's covered by mock vs. deferred to a real deployment
// window.

import * as jose from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  writebackActorEmail,
  trackerBaseUrl,
  mintWritebackJwt,
  callTrackerTool,
  parseRunTags,
  extractDeliveryFromArtifactTexts,
  onRunTerminal,
  attemptWithBackoff,
  parseTemplateDeviationTags,
  buildTemplateDeviation,
  type WritebackOutcome,
} from "./tracker-client.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.A2A_SECRET = "test-shared-a2a-secret";
  delete process.env.WRITEBACK_ACTOR_EMAIL;
  delete process.env.TRACKER_BASE_URL;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── writebackActorEmail / trackerBaseUrl ────────────────────────────────────

describe("writebackActorEmail", () => {
  it("defaults to the reserved sentinel address", () => {
    expect(writebackActorEmail()).toBe("writeback@orchestrator.internal");
  });

  it("is overridable via env, matching the tracker side's own env contract", () => {
    process.env.WRITEBACK_ACTOR_EMAIL = "custom-writeback@example.com";
    expect(writebackActorEmail()).toBe("custom-writeback@example.com");
  });

  it("falls back to the default when the env var is blank", () => {
    process.env.WRITEBACK_ACTOR_EMAIL = "   ";
    expect(writebackActorEmail()).toBe("writeback@orchestrator.internal");
  });
});

describe("trackerBaseUrl", () => {
  it("defaults to the same-network container hostname", () => {
    expect(trackerBaseUrl()).toBe("http://an-tracker:3002");
  });

  it("is overridable via TRACKER_BASE_URL and strips a trailing slash", () => {
    process.env.TRACKER_BASE_URL = "https://tracker.example.com/";
    expect(trackerBaseUrl()).toBe("https://tracker.example.com");
  });
});

// ── mintWritebackJwt ─────────────────────────────────────────────────────────

describe("mintWritebackJwt", () => {
  it("mints a JWT whose sub is the sentinel and carries org_id as an extra claim", async () => {
    const jwt = await mintWritebackJwt("org-42");
    const payload = jose.decodeJwt(jwt);
    expect(payload.sub).toBe("writeback@orchestrator.internal");
    expect(payload.org_id).toBe("org-42");
  });

  it("omits org_id when orgId is null (still signs successfully)", async () => {
    const jwt = await mintWritebackJwt(null);
    const payload = jose.decodeJwt(jwt);
    expect(payload.sub).toBe("writeback@orchestrator.internal");
    expect(payload.org_id).toBeUndefined();
  });

  it("verifies against the shared A2A_SECRET (round-trip)", async () => {
    const jwt = await mintWritebackJwt("org-7");
    const { payload } = await jose.jwtVerify(
      jwt,
      new TextEncoder().encode(process.env.A2A_SECRET!),
    );
    expect(payload.sub).toBe("writeback@orchestrator.internal");
    expect(payload.org_id).toBe("org-7");
  });
});

// ── callTrackerTool (mock A2A/MCP transport) ───────────────────────────────

function mockFetchJsonRpcResult(structuredContent: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    text: async () =>
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { structuredContent },
      }),
  });
}

describe("callTrackerTool", () => {
  it("POSTs a tools/call JSON-RPC envelope to the tracker MCP endpoint with a bearer JWT", async () => {
    const fetchMock = mockFetchJsonRpcResult({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const result = await callTrackerTool("org-1", "writeback-exec-state", {
      workItemId: "wi-1",
      target: "returned",
    });

    expect(result.data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://an-tracker:3002/tracker/_agent-native/mcp");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toMatch(/^Bearer /);
    const jwt = init.headers.Authorization.slice("Bearer ".length);
    const payload = jose.decodeJwt(jwt);
    expect(payload.sub).toBe("writeback@orchestrator.internal");
    expect(payload.org_id).toBe("org-1");

    const body = JSON.parse(init.body);
    expect(body.method).toBe("tools/call");
    expect(body.params.name).toBe("writeback-exec-state");
    expect(body.params.arguments).toEqual({
      workItemId: "wi-1",
      target: "returned",
    });
  });

  it("falls back to parsing content[].text when structuredContent is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [{ type: "text", text: '{"workItemId":"wi-2"}' }],
            },
          }),
      }),
    );
    const result = await callTrackerTool(null, "writeback-run-meta", {});
    expect(result.data).toEqual({ workItemId: "wi-2" });
  });

  it("throws on HTTP failure (e.g. tracker returning 503)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => "Service Unavailable",
      }),
    );
    await expect(
      callTrackerTool(null, "writeback-exec-state", {
        workItemId: "wi-1",
        target: "queued",
      }),
    ).rejects.toThrow(/HTTP 503/);
  });

  it("throws on a structured tool error (isError)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              isError: true,
              content: [{ type: "text", text: "actor-denied" }],
            },
          }),
      }),
    );
    await expect(
      callTrackerTool(null, "writeback-exec-state", {
        workItemId: "wi-1",
        target: "queued",
      }),
    ).rejects.toThrow(/actor-denied/);
  });

  it("throws on a JSON-RPC level error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "boom" } }),
      }),
    );
    await expect(
      callTrackerTool(null, "writeback-exec-state", {
        workItemId: "wi-1",
        target: "queued",
      }),
    ).rejects.toThrow(/boom/);
  });
});

// ── parseRunTags ─────────────────────────────────────────────────────────────

describe("parseRunTags", () => {
  it("extracts workItemId/orgId from tags.item_id/tags.org_id", () => {
    expect(
      parseRunTags({ item_id: "wi-9", org_id: "org-9", source: "tracker" }),
    ).toEqual({
      workItemId: "wi-9",
      orgId: "org-9",
    });
  });

  it("returns nulls for missing/absent keys", () => {
    expect(parseRunTags({ source: "tracker" })).toEqual({
      workItemId: null,
      orgId: null,
    });
  });

  it("tolerates null/non-object tags (non-tracker runs)", () => {
    expect(parseRunTags(null)).toEqual({ workItemId: null, orgId: null });
    expect(parseRunTags(undefined)).toEqual({ workItemId: null, orgId: null });
    expect(parseRunTags("not-an-object")).toEqual({
      workItemId: null,
      orgId: null,
    });
  });
});

// ── extractDeliveryFromArtifactTexts ────────────────────────────────────────

describe("extractDeliveryFromArtifactTexts", () => {
  it("finds a PR url and branch from artifact text", () => {
    const { branch, prUrl } = extractDeliveryFromArtifactTexts([
      "Opened https://github.com/acme/repo/pull/42 from orchestrator/run-abc123",
    ]);
    expect(prUrl).toBe("https://github.com/acme/repo/pull/42");
    expect(branch).toBe("orchestrator/run-abc123");
  });

  it("returns nulls when nothing matches (zero-delivery signal)", () => {
    expect(
      extractDeliveryFromArtifactTexts([
        "just some analysis text",
        null,
        undefined,
      ]),
    ).toEqual({ branch: null, prUrl: null });
  });
});

// ── parseTemplateDeviationTags / buildTemplateDeviation (R4a.3 L2) ──────────

describe("parseTemplateDeviationTags", () => {
  it("extracts suggestedTemplate/ruleId/deviationReason when present", () => {
    expect(
      parseTemplateDeviationTags({
        suggestedTemplate: "sdlc-issue-pipeline",
        ruleId: "rule-1",
        deviationReason: "改动仅 1 文件",
      }),
    ).toEqual({
      suggestedTemplate: "sdlc-issue-pipeline",
      ruleId: "rule-1",
      deviationReason: "改动仅 1 文件",
    });
  });

  it("returns nulls for missing/wrong-typed keys or a non-object tags value", () => {
    expect(parseTemplateDeviationTags({})).toEqual({
      suggestedTemplate: null,
      ruleId: null,
      deviationReason: null,
    });
    expect(parseTemplateDeviationTags({ suggestedTemplate: 42 })).toEqual({
      suggestedTemplate: null,
      ruleId: null,
      deviationReason: null,
    });
    expect(parseTemplateDeviationTags(null)).toEqual({
      suggestedTemplate: null,
      ruleId: null,
      deviationReason: null,
    });
  });
});

describe("buildTemplateDeviation", () => {
  it("returns undefined when there is no chosen template name", () => {
    expect(
      buildTemplateDeviation(null, { suggestedTemplate: "hotfix" }),
    ).toBeUndefined();
  });

  it("returns undefined when there is no L1 suggestion to compare against", () => {
    expect(buildTemplateDeviation("quick-task", {})).toBeUndefined();
  });

  it("returns undefined when chosen matches suggested and no deviationReason was logged", () => {
    expect(
      buildTemplateDeviation("hotfix", { suggestedTemplate: "hotfix" }),
    ).toBeUndefined();
  });

  it("returns a receipt when chosen differs from suggested", () => {
    expect(
      buildTemplateDeviation("quick-task", {
        suggestedTemplate: "sdlc-issue-pipeline",
      }),
    ).toEqual({ chosen: "quick-task", suggested: "sdlc-issue-pipeline" });
  });

  it("includes deviationReason when the brain logged one, even if chosen matches suggested", () => {
    expect(
      buildTemplateDeviation("hotfix", {
        suggestedTemplate: "hotfix",
        deviationReason: "手工确认后仍走建议模板",
      }),
    ).toEqual({
      chosen: "hotfix",
      suggested: "hotfix",
      deviationReason: "手工确认后仍走建议模板",
    });
  });
});

// ── onRunTerminal ────────────────────────────────────────────────────────────

describe("onRunTerminal", () => {
  it("delivered: calls writeback-run-meta, writeback-exec-state(returned), then advance-stage twice (实施→测试→验收)", async () => {
    const fetchMock = mockFetchJsonRpcResult({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const outcome: WritebackOutcome = {
      kind: "delivered",
      workItemId: "wi-1",
      orgId: "org-1",
      runId: "run-1",
      branch: "orchestrator/run-1",
    };
    await onRunTerminal(outcome);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const calls = fetchMock.mock.calls.map((call: any[]) => {
      const [, init] = call as [string, any];
      const body = JSON.parse(init.body);
      return { name: body.params.name, args: body.params.arguments };
    });
    expect(calls[0]).toEqual({
      name: "writeback-run-meta",
      args: {
        workItemId: "wi-1",
        runId: "run-1",
        branch: "orchestrator/run-1",
      },
    });
    expect(calls[1]).toEqual({
      name: "writeback-exec-state",
      args: { workItemId: "wi-1", target: "returned", reason: "run-done" },
    });
    expect(calls[2]).toEqual({
      name: "advance-stage",
      args: {
        scope: "item",
        id: "wi-1",
        fromStage: "实施",
        expectedRunId: "run-1",
      },
    });
    expect(calls[3]).toEqual({
      name: "advance-stage",
      args: {
        scope: "item",
        id: "wi-1",
        fromStage: "测试",
        expectedRunId: "run-1",
      },
    });

    // Every call must carry the sentinel identity — a wrong actor would be
    // rejected by the tracker's own double-factor writeback-actor gate.
    for (const [, init] of fetchMock.mock.calls) {
      const jwt = (init as any).headers.Authorization.slice("Bearer ".length);
      const payload = jose.decodeJwt(jwt);
      expect(payload.sub).toBe("writeback@orchestrator.internal");
      expect(payload.org_id).toBe("org-1");
    }
  });

  it("delivered + templateDeviation: forwards it as part of the writeback-run-meta call", async () => {
    const fetchMock = mockFetchJsonRpcResult({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const outcome: WritebackOutcome = {
      kind: "delivered",
      workItemId: "wi-1",
      orgId: "org-1",
      runId: "run-1",
      branch: "orchestrator/run-1",
      templateDeviation: {
        chosen: "quick-task",
        suggested: "sdlc-issue-pipeline",
        deviationReason: "改动仅 1 文件",
      },
    };
    await onRunTerminal(outcome);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.params.name).toBe("writeback-run-meta");
    expect(body.params.arguments).toEqual({
      workItemId: "wi-1",
      runId: "run-1",
      branch: "orchestrator/run-1",
      templateDeviation: {
        chosen: "quick-task",
        suggested: "sdlc-issue-pipeline",
        deviationReason: "改动仅 1 文件",
      },
    });
  });

  it("zero-delivery: calls writeback-exec-state(queued) only — no run-meta, no advance-stage", async () => {
    const fetchMock = mockFetchJsonRpcResult({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const outcome: WritebackOutcome = {
      kind: "zero-delivery",
      workItemId: "wi-2",
      orgId: null,
      runId: "run-2",
      reason: "run-failed",
    };
    await onRunTerminal(outcome);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.params.name).toBe("writeback-exec-state");
    expect(body.params.arguments).toEqual({
      workItemId: "wi-2",
      target: "queued",
      reason: "run-failed",
    });
  });

  it("propagates the underlying error on tracker failure (so the caller can retry)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => "down",
      }),
    );
    await expect(
      onRunTerminal({
        kind: "zero-delivery",
        workItemId: "wi-3",
        orgId: null,
        reason: "run-failed",
      }),
    ).rejects.toThrow(/HTTP 503/);
  });
});

// ── attemptWithBackoff ───────────────────────────────────────────────────────

describe("attemptWithBackoff", () => {
  it("succeeds on the first attempt without sleeping", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await attemptWithBackoff(fn, [1, 1, 1]);
    expect(result).toEqual({ ok: true, value: "ok", attempts: 1 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries after failures and succeeds within the attempt budget", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("503"))
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValue("ok-third-try");
    const result = await attemptWithBackoff(fn, [1, 1, 1]);
    expect(result).toEqual({ ok: true, value: "ok-third-try", attempts: 3 });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gives up after exhausting all attempts (T-F9-06: 3 backoffs ⇒ 4 attempts)", async () => {
    const err = new Error("persistent 503");
    const fn = vi.fn().mockRejectedValue(err);
    const result = await attemptWithBackoff(fn, [1, 1, 1]);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(err);
    expect(result.attempts).toBe(4);
    expect(fn).toHaveBeenCalledTimes(4);
  });
});
