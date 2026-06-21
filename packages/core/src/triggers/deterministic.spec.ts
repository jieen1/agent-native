/**
 * Unit tests for the deterministic single-step executor (Phase A4 §1.5.10).
 *
 * `runDeterministicStep` is a pure executor: it parses the routine body's
 * declaration, then calls EITHER the wired `web-request` fetch-tool entry OR a
 * named action from the registry — never an agent loop / LLM. These tests pin:
 *   - web-request declaration → `ctx.actions["web-request"].run` called once
 *     with the substituted-shape args (url/method/headers/body).
 *   - action declaration → `ctx.actions[name].run(params)` called once.
 *   - fenced ```json block is extracted from a larger body.
 *   - illegal declarations (unknown kind, missing field, multi-step array,
 *     malformed JSON, unknown action) throw.
 */

import { describe, expect, it, vi } from "vitest";
import {
  deterministicStepSchema,
  parseDeterministicStep,
  runDeterministicStep,
} from "./deterministic.js";
import type { ActionEntry } from "../agent/production-agent.js";

function entry(run: ActionEntry["run"]): ActionEntry {
  return { tool: { description: "", parameters: { type: "object" } }, run };
}

describe("runDeterministicStep — web-request", () => {
  it("calls the wired web-request entry exactly once with the declared shape", async () => {
    const webRequestSpy = vi.fn(async () => "HTTP 200 OK");
    const actions = { "web-request": entry(webRequestSpy) };

    const body = [
      "```json",
      JSON.stringify({
        kind: "web-request",
        method: "POST",
        url: "https://hooks.example.com/${keys.WEBHOOK}",
        headers: { "Content-Type": "application/json" },
        body: '{"text":"hi"}',
      }),
      "```",
    ].join("\n");

    const result = await runDeterministicStep(body, { actions });

    expect(webRequestSpy).toHaveBeenCalledTimes(1);
    const args = webRequestSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(args.url).toBe("https://hooks.example.com/${keys.WEBHOOK}");
    expect(args.method).toBe("POST");
    // headers are passed as a JSON string (fetch-tool accepts string or object).
    expect(args.headers).toBe(
      JSON.stringify({ "Content-Type": "application/json" }),
    );
    expect(args.body).toBe('{"text":"hi"}');
    expect(result).toEqual({ kind: "web-request", output: "HTTP 200 OK" });
  });

  it("defaults method to GET and omits headers when not declared", async () => {
    const webRequestSpy = vi.fn(async () => "ok");
    const actions = { "web-request": entry(webRequestSpy) };
    const body =
      '```json\n{"kind":"web-request","url":"https://example.com/x"}\n```';

    await runDeterministicStep(body, { actions });

    const args = webRequestSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(args.method).toBe("GET");
    expect(args.headers).toBeUndefined();
    expect(args.body).toBeUndefined();
  });

  it("throws when the web-request tool is not in the registry", async () => {
    const body = '{"kind":"web-request","url":"https://example.com"}';
    await expect(runDeterministicStep(body, { actions: {} })).rejects.toThrow(
      /web-request tool is unavailable/i,
    );
  });
});

describe("runDeterministicStep — action", () => {
  it("calls the named action once with the declared params", async () => {
    const actionSpy = vi.fn(async () => ({ ok: true }));
    const actions = { "send-notification": entry(actionSpy) };
    const body = JSON.stringify({
      kind: "action",
      action: "send-notification",
      params: { to: "me", text: "hey" },
    });

    const result = await runDeterministicStep(body, { actions });

    expect(actionSpy).toHaveBeenCalledTimes(1);
    expect(actionSpy).toHaveBeenCalledWith({ to: "me", text: "hey" });
    expect(result).toEqual({ kind: "action", output: { ok: true } });
  });

  it("defaults params to {} when omitted", async () => {
    const actionSpy = vi.fn(async () => null);
    const actions = { ping: entry(actionSpy) };
    await runDeterministicStep('{"kind":"action","action":"ping"}', {
      actions,
    });
    expect(actionSpy).toHaveBeenCalledWith({});
  });

  it("throws on an unknown action name", async () => {
    const body = '{"kind":"action","action":"does-not-exist"}';
    await expect(runDeterministicStep(body, { actions: {} })).rejects.toThrow(
      /Unknown action: "does-not-exist"/,
    );
  });
});

describe("runDeterministicStep — declaration validation", () => {
  it("rejects an unknown kind", async () => {
    const body = '{"kind":"shell","cmd":"rm -rf /"}';
    await expect(runDeterministicStep(body, { actions: {} })).rejects.toThrow();
  });

  it("rejects a multi-step array", async () => {
    const body =
      '[{"kind":"action","action":"a"},{"kind":"action","action":"b"}]';
    await expect(runDeterministicStep(body, { actions: {} })).rejects.toThrow();
  });

  it("rejects a web-request declaration missing url", async () => {
    const body = '{"kind":"web-request","method":"POST"}';
    await expect(runDeterministicStep(body, { actions: {} })).rejects.toThrow();
  });

  it("rejects malformed JSON with a clear message", async () => {
    await expect(
      runDeterministicStep("not json at all", { actions: {} }),
    ).rejects.toThrow(/not valid JSON/i);
  });

  it("rejects unknown fields via .strict()", () => {
    expect(() =>
      deterministicStepSchema.parse({
        kind: "action",
        action: "x",
        unexpected: true,
      }),
    ).toThrow();
  });
});

describe("parseDeterministicStep", () => {
  it("extracts the first fenced json block from a larger body", () => {
    const body = [
      "Some prose the agentic path would have used as a prompt.",
      "",
      "```json",
      '{ "kind": "action", "action": "do-thing", "params": { "n": 1 } }',
      "```",
      "",
      "trailing text",
    ].join("\n");
    const decl = parseDeterministicStep(body);
    expect(decl).toEqual({
      kind: "action",
      action: "do-thing",
      params: { n: 1 },
    });
  });

  it("tolerates a bare (unfenced) JSON body", () => {
    const decl = parseDeterministicStep('  {"kind":"action","action":"x"}  ');
    expect(decl.kind).toBe("action");
  });
});
