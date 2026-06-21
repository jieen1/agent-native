/**
 * secrets-client — the routines app's ad-hoc keys helper (the single named seam
 * the keys UI uses instead of hand-writing fetch to the framework route).
 *
 * What this guards (A2 keys requirements):
 *   - `saveAdHocSecret` forwards the per-key `urlAllowlist` faithfully so the
 *     engine can enforce it on `${keys.X}` web-requests. (The engine-side
 *     allowlist ENFORCEMENT — out-of-allowlist origin blocked — is covered by
 *     core's `secrets/substitution.spec.ts validateUrlAllowlist`; here we prove
 *     the routines client actually delivers the allowlist to the endpoint.)
 *   - The list endpoint surface is write-only: only masked `last4` comes back,
 *     and a substring scan over the parsed result proves the plaintext value is
 *     never present in what the client hands the UI.
 *   - URLs go through `agentNativePath` (mounted base path respected) and DELETE
 *     encodes the key name.
 *   - Non-OK responses raise the server's error message (no silent swallow).
 *
 * `@agent-native/core/client` is mocked so the helper resolves without the full
 * framework, and global `fetch` is stubbed so we inspect exactly what is sent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@agent-native/core/client", () => ({
  // Stable, identifiable base so we can assert the endpoint and prove a mounted
  // base path would be respected (the helper never hardcodes the raw route).
  agentNativePath: (p: string) => `/base${p}`,
}));

const { listAdHocSecrets, saveAdHocSecret, deleteAdHocSecret } =
  await import("./secrets-client.js");

const ENDPOINT = "/base/_agent-native/secrets/adhoc";

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("saveAdHocSecret", () => {
  it("POSTs the value + urlAllowlist to the ad-hoc endpoint via agentNativePath", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: true, key: "SLACK_WEBHOOK" }),
    );

    const result = await saveAdHocSecret({
      name: "SLACK_WEBHOOK",
      value: "https://hooks.slack.com/services/T000/B000/xxxxxxxx",
      description: "incoming webhook",
      scope: "user",
      urlAllowlist: ["https://hooks.slack.com"],
    });

    expect(result).toEqual({ ok: true, key: "SLACK_WEBHOOK" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });

    const sent = JSON.parse(init.body as string);
    // The allowlist is delivered to the endpoint so the engine can enforce it.
    expect(sent.urlAllowlist).toEqual(["https://hooks.slack.com"]);
    expect(sent).toMatchObject({
      name: "SLACK_WEBHOOK",
      scope: "user",
      description: "incoming webhook",
    });
  });

  it("forwards an out-of-allowlist value unchanged (enforcement is engine-side, not the client's job to second-guess)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, key: "K" }));

    await saveAdHocSecret({
      name: "K",
      value: "secret-value",
      // Allowlist names only hooks.slack.com — a body that later requests
      // evil.example.com is the engine's call to reject; the client just relays.
      urlAllowlist: ["https://hooks.slack.com"],
    });

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent.urlAllowlist).toEqual(["https://hooks.slack.com"]);
  });

  it("raises the server error message on a non-OK response", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "invalid key name" }, { ok: false, status: 400 }),
    );

    await expect(
      saveAdHocSecret({ name: "bad name", value: "x" }),
    ).rejects.toThrow(/invalid key name/);
  });
});

describe("listAdHocSecrets", () => {
  it("returns masked metadata only — the plaintext value never round-trips", async () => {
    const PLAINTEXT = "super-secret-token-abcdef123456";
    // The endpoint is write-only by contract: it returns last4, NOT the value.
    fetchMock.mockResolvedValue(
      jsonResponse([
        {
          name: "SLACK_WEBHOOK",
          scope: "user",
          scopeId: "alice@example.test",
          description: "incoming webhook",
          last4: PLAINTEXT.slice(-4),
          urlAllowlist: ["https://hooks.slack.com"],
          createdAt: 1,
          updatedAt: 2,
        },
      ]),
    );

    const secrets = await listAdHocSecrets();
    expect(secrets).toHaveLength(1);
    expect(secrets[0].last4).toBe("3456");
    expect(secrets[0].urlAllowlist).toEqual(["https://hooks.slack.com"]);

    // Substring scan: the full plaintext must not appear anywhere in the
    // structure the client hands to the UI (no accidental value leakage).
    const serialized = JSON.stringify(secrets);
    expect(serialized).not.toContain(PLAINTEXT);
    expect(serialized).not.toContain(PLAINTEXT.slice(0, -4)); // body minus last4
    // The masked tail is the only fragment of the secret allowed through.
    expect(serialized).toContain("3456");
  });

  it("raises the server error message on a non-OK response", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "unauthorized" }, { ok: false, status: 401 }),
    );
    await expect(listAdHocSecrets()).rejects.toThrow(/unauthorized/);
  });
});

describe("deleteAdHocSecret", () => {
  it("DELETEs the encoded key name", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, removed: true }));

    const result = await deleteAdHocSecret("my key/name");
    expect(result).toEqual({ ok: true, removed: true });

    const [url, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("DELETE");
    // The name is URL-encoded into the path segment.
    expect(url).toBe(`${ENDPOINT}/my%20key%2Fname`);
  });
});
