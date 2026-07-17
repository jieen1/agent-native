// Task board #84 — activating a vLLM/OpenAI-compatible runtime now writes the
// runtime's own configured API key (if save-runtime-config ever stored one via
// the secrets vault) as OPENAI_API_KEY instead of unconditionally writing the
// "local-openai-compatible" placeholder. Local vLLM/LM Studio runtimes that
// never configured a real key must keep getting the exact same placeholder
// behavior as before this change.

import { describe, it, expect, beforeEach, vi } from "vitest";

import activateRuntime from "./activate-runtime.js";

const hoisted = vi.hoisted(() => {
  const state = {
    rows: [] as Array<Record<string, unknown>>,
    updates: [] as Array<Record<string, unknown>>,
  };
  return {
    state,
    makeDb: () => ({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: (n: number) => Promise.resolve(state.rows.slice(0, n)),
          }),
        }),
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
const mockReadAppSecret = vi.fn();
const mockPutSetting = vi.fn().mockResolvedValue(undefined);
const mockDeleteSetting = vi.fn().mockResolvedValue(undefined);

vi.mock("@agent-native/core/secrets", () => ({
  writeAppSecret: (...args: unknown[]) => mockWriteAppSecret(...args),
  readAppSecret: (...args: unknown[]) => mockReadAppSecret(...args),
}));

vi.mock("@agent-native/core/settings", () => ({
  putSetting: (...args: unknown[]) => mockPutSetting(...args),
  deleteSetting: (...args: unknown[]) => mockDeleteSetting(...args),
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
  hoisted.state.rows.length = 0;
  hoisted.state.updates.length = 0;
  mockWriteAppSecret.mockClear();
  mockReadAppSecret.mockReset();
  mockReadAppSecret.mockResolvedValue(null);
  mockPutSetting.mockClear();
  mockDeleteSetting.mockClear();
}

describe("activate-runtime — real API key takes precedence (task #84)", () => {
  beforeEach(() => {
    resetState();
  });

  it("writes the runtime's configured real key as OPENAI_API_KEY when one was saved", async () => {
    hoisted.state.rows.push({
      id: "rt_groq",
      kind: "openai-compatible",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "llama-3.3-70b",
      ownerEmail: "owner@example.com",
    });
    mockReadAppSecret.mockResolvedValueOnce({
      value: "gsk-real-secret",
      last4: "cret",
      updatedAt: 1,
    });

    const result = await activateRuntime.run({ id: "rt_groq" });

    expect(result).toEqual({
      id: "rt_groq",
      kind: "openai-compatible",
      ok: true,
    });
    expect(mockReadAppSecret).toHaveBeenCalledWith({
      key: "runtime-api-key:rt_groq",
      scope: "user",
      scopeId: "owner@example.com",
    });
    expect(mockWriteAppSecret).toHaveBeenCalledWith({
      key: "OPENAI_API_KEY",
      value: "gsk-real-secret",
      scope: "user",
      scopeId: "owner@example.com",
    });
  });

  it("falls back to the local placeholder when no real key was ever configured (existing vLLM/LM Studio behavior)", async () => {
    hoisted.state.rows.push({
      id: "rt_local",
      kind: "vllm",
      baseUrl: "http://localhost:8000/v1",
      model: "qwen",
      ownerEmail: "owner@example.com",
    });
    mockReadAppSecret.mockResolvedValueOnce(null);

    const result = await activateRuntime.run({ id: "rt_local" });

    expect(result).toEqual({ id: "rt_local", kind: "vllm", ok: true });
    expect(mockWriteAppSecret).toHaveBeenCalledWith({
      key: "OPENAI_API_KEY",
      value: "local-openai-compatible",
      scope: "user",
      scopeId: "owner@example.com",
    });
  });

  it("claude-code runtimes never read or write the OPENAI_API_KEY secret", async () => {
    hoisted.state.rows.push({
      id: "rt_cc",
      kind: "claude-code",
      baseUrl: null,
      model: null,
      ownerEmail: "owner@example.com",
    });

    const result = await activateRuntime.run({ id: "rt_cc" });

    expect(result).toEqual({ id: "rt_cc", kind: "claude-code", ok: true });
    expect(mockReadAppSecret).not.toHaveBeenCalled();
    expect(mockWriteAppSecret).not.toHaveBeenCalled();
    expect(mockPutSetting).toHaveBeenCalledWith("orchestrator-runtime", {
      runtime: "claude-code",
      runtimeConfigId: "rt_cc",
    });
  });
});
