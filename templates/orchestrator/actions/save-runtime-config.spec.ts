// Task board #84 — the add-runtime form gained an optional real API key for
// remote OpenAI-compatible providers (OpenAI, Groq, DeepSeek, a hosted vLLM
// behind auth, ...). Per this project's "no credential-shaped plain columns"
// rule, the key must never land in `runtime_configs` — it's written to the
// secrets vault, scoped by a key that folds in the row's own id
// (runtimeApiKeySecretKey, actions/_util.ts), inside the owning user's normal
// `{scope:"user", scopeId: ownerEmail}` secret scope.
//
// Mirrors brain-task-slot.spec.ts's mocking approach: real schema (so the
// production code's `eq`/`and` build against genuine Drizzle Column objects),
// a hand-rolled db stub that ignores the WHERE clause and records what was
// inserted/updated.

import { describe, it, expect, beforeEach, vi } from "vitest";

import saveRuntimeConfig from "./save-runtime-config.js";

const hoisted = vi.hoisted(() => {
  const state = {
    inserts: [] as Array<Record<string, unknown>>,
    updates: [] as Array<Record<string, unknown>>,
  };
  return {
    state,
    makeDb: () => ({
      insert: (_table: unknown) => ({
        values: (vals: Record<string, unknown>) => {
          state.inserts.push(vals);
          return Promise.resolve();
        },
      }),
      update: (_table: unknown) => ({
        set: (vals: Record<string, unknown>) => ({
          where: (_filter: unknown) => {
            state.updates.push(vals);
            return Promise.resolve();
          },
        }),
      }),
    }),
  };
});

const mockWriteAppSecret = vi.fn().mockResolvedValue("secret-id");

vi.mock("@agent-native/core/secrets", () => ({
  writeAppSecret: (...args: unknown[]) => mockWriteAppSecret(...args),
}));

vi.mock("@agent-native/core/server/request-context", () => ({
  getRequestUserEmail: () => "owner@example.com",
  getRequestOrgId: () => "org-1",
}));

vi.mock("../server/db/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/db/index.js")>();
  return {
    ...actual,
    getDb: () => hoisted.makeDb(),
  };
});

function resetState(): void {
  hoisted.state.inserts.length = 0;
  hoisted.state.updates.length = 0;
  mockWriteAppSecret.mockClear();
}

describe("save-runtime-config — optional apiKey (task #84)", () => {
  beforeEach(() => {
    resetState();
  });

  it("create without an apiKey never touches the secrets vault", async () => {
    const result = await saveRuntimeConfig.run({
      name: "local vLLM",
      kind: "vllm",
      baseUrl: "http://localhost:8000/v1",
      model: "qwen",
    });

    expect(result.ok).toBe(true);
    expect(mockWriteAppSecret).not.toHaveBeenCalled();
    expect(hoisted.state.inserts).toHaveLength(1);
    expect(hoisted.state.inserts[0]).not.toHaveProperty("apiKey");
  });

  it("create with an apiKey stores it via writeAppSecret keyed by the NEW row's id, never as a plain column", async () => {
    const result = await saveRuntimeConfig.run({
      name: "Groq",
      kind: "vllm",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "llama-3.3-70b",
      apiKey: "gsk-real-secret-value",
    });

    expect(result.ok).toBe(true);
    expect(hoisted.state.inserts).toHaveLength(1);
    const insertedId = hoisted.state.inserts[0].id;
    expect(result.id).toBe(insertedId);
    expect(hoisted.state.inserts[0]).not.toHaveProperty("apiKey");

    expect(mockWriteAppSecret).toHaveBeenCalledTimes(1);
    expect(mockWriteAppSecret).toHaveBeenCalledWith({
      key: `runtime-api-key:${insertedId}`,
      value: "gsk-real-secret-value",
      scope: "user",
      scopeId: "owner@example.com",
    });
  });

  it("update with an apiKey stores it scoped to the EXISTING row's id", async () => {
    const result = await saveRuntimeConfig.run({
      id: "rt_existing123",
      name: "Together AI",
      kind: "openai-compatible",
      baseUrl: "https://api.together.xyz/v1",
      apiKey: "together-real-key",
    });

    expect(result).toEqual({ id: "rt_existing123", ok: true });
    expect(hoisted.state.updates).toHaveLength(1);
    expect(hoisted.state.updates[0]).not.toHaveProperty("apiKey");

    expect(mockWriteAppSecret).toHaveBeenCalledTimes(1);
    expect(mockWriteAppSecret).toHaveBeenCalledWith({
      key: "runtime-api-key:rt_existing123",
      value: "together-real-key",
      scope: "user",
      scopeId: "owner@example.com",
    });
  });

  it("update without an apiKey leaves any previously-configured secret untouched", async () => {
    await saveRuntimeConfig.run({
      id: "rt_existing123",
      name: "Together AI (renamed)",
      kind: "openai-compatible",
      baseUrl: "https://api.together.xyz/v1",
    });

    expect(mockWriteAppSecret).not.toHaveBeenCalled();
  });

  it("a blank/whitespace apiKey is treated as not provided", async () => {
    await saveRuntimeConfig.run({
      name: "local LM Studio",
      kind: "vllm",
      baseUrl: "http://localhost:1234/v1",
      apiKey: "   ",
    });

    expect(mockWriteAppSecret).not.toHaveBeenCalled();
  });
});
