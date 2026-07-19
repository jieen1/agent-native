// Brain runtime-switching (additive feature) — set-brain-model's new
// `runtime:<id>` validation branch. Mirrors save-runtime-config.spec.ts's
// mocking approach: real schema (so resolveOwnerRuntimeRow's `eq`/`and` build
// against genuine Drizzle Column objects), a hand-rolled db stub that IGNORES
// the WHERE clause and just returns whatever the test seeded into
// `state.rows` — the same simplification activate-runtime.spec.ts /
// save-runtime-config.spec.ts already use, so "another owner's row" and "a
// nonexistent id" are both simulated as an empty result set (a real,
// owner-scoped query would return zero rows for either case).
//
// The existing Claude-id paths (unchanged, per the feature's zero-behavior-
// change constraint) get a couple of quick regression checks too, since no
// spec file existed for this action before this change.

import { describe, it, expect, beforeEach, vi } from "vitest";

import setBrainModel from "./set-brain-model.js";

const hoisted = vi.hoisted(() => {
  const state = {
    rows: [] as Array<Record<string, unknown>>,
    settings: new Map<string, unknown>(),
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
    }),
  };
});

const mockGetRequestUserEmail = vi.fn(() => "owner@example.com");

vi.mock("@agent-native/core/server/request-context", () => ({
  getRequestUserEmail: (...args: unknown[]) => mockGetRequestUserEmail(...args),
}));

vi.mock("@agent-native/core/settings", () => ({
  getSetting: vi.fn(
    async (key: string) => hoisted.state.settings.get(key) ?? null,
  ),
  putSetting: vi.fn(async (key: string, value: unknown) => {
    hoisted.state.settings.set(key, value);
  }),
}));

vi.mock("../server/db/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/db/index.js")>();
  return {
    ...actual,
    getDb: () => hoisted.makeDb(),
  };
});

import { putSetting } from "@agent-native/core/settings";

function resetState(): void {
  hoisted.state.rows.length = 0;
  hoisted.state.settings.clear();
  mockGetRequestUserEmail.mockClear();
  mockGetRequestUserEmail.mockReturnValue("owner@example.com");
  vi.mocked(putSetting).mockClear();
}

const aliyunRow = {
  id: "rt_4ry56fwd1yj763f3",
  name: "Aliyun Bailian",
  kind: "openai-compatible",
  baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  model: "qwen3.8-max-preview",
  active: 1,
};

describe("set-brain-model — runtime:<id> validation branch", () => {
  beforeEach(() => {
    resetState();
  });

  it("accepts an owned, valid, non-claude-code row with baseUrl+model — persists + returns the row's name", async () => {
    hoisted.state.rows.push(aliyunRow);

    const result = await setBrainModel.run({
      model: `runtime:${aliyunRow.id}`,
    });

    expect(result).toEqual({
      brainModel: `runtime:${aliyunRow.id}`,
      current: `runtime:${aliyunRow.id}`,
      cleared: false,
      name: aliyunRow.name,
    });
    expect(putSetting).toHaveBeenCalledWith("brain-model", {
      model: `runtime:${aliyunRow.id}`,
    });
  });

  it("rejects a nonexistent id (no row for this owner)", async () => {
    // state.rows left empty — simulates the owner-scoped query finding nothing.
    await expect(
      setBrainModel.run({ model: "runtime:rt_does_not_exist" }),
    ).rejects.toThrow(/no saved runtime config with that id exists/);
    expect(putSetting).not.toHaveBeenCalled();
  });

  it("rejects another owner's row (also simulated as an empty result set)", async () => {
    // A real owner-scoped query for someone ELSE's row id returns zero rows,
    // exactly like the nonexistent-id case above.
    await expect(
      setBrainModel.run({ model: "runtime:rt_someone_elses_row" }),
    ).rejects.toThrow(/no saved runtime config with that id exists/);
    expect(putSetting).not.toHaveBeenCalled();
  });

  it("rejects a claude-code-kind row", async () => {
    hoisted.state.rows.push({
      id: "rt_cc",
      name: "Claude Code",
      kind: "claude-code",
      baseUrl: null,
      model: null,
      active: 1,
    });

    await expect(setBrainModel.run({ model: "runtime:rt_cc" })).rejects.toThrow(
      /is a Claude Code runtime, not an openai-compatible\/vllm endpoint/,
    );
    expect(putSetting).not.toHaveBeenCalled();
  });

  it("rejects a row missing baseUrl", async () => {
    hoisted.state.rows.push({ ...aliyunRow, baseUrl: null });
    await expect(
      setBrainModel.run({ model: `runtime:${aliyunRow.id}` }),
    ).rejects.toThrow(/is missing a base URL or model/);
    expect(putSetting).not.toHaveBeenCalled();
  });

  it("rejects a row missing model", async () => {
    hoisted.state.rows.push({ ...aliyunRow, model: null });
    await expect(
      setBrainModel.run({ model: `runtime:${aliyunRow.id}` }),
    ).rejects.toThrow(/is missing a base URL or model/);
    expect(putSetting).not.toHaveBeenCalled();
  });

  it("throws when unauthenticated (no request user email)", async () => {
    mockGetRequestUserEmail.mockReturnValue(null as unknown as string);
    await expect(
      setBrainModel.run({ model: `runtime:${aliyunRow.id}` }),
    ).rejects.toThrow(/Not authenticated/);
  });

  it("skips tier gating entirely for the runtime: branch (an active-tier-only accepted row is not blocked)", async () => {
    hoisted.state.rows.push(aliyunRow);
    // Even with the default "sonnet" tier (no tier setting saved), a runtime
    // override is never blocked — tier gating only applies to Claude ids.
    const result = await setBrainModel.run({
      model: `runtime:${aliyunRow.id}`,
    });
    expect(result.cleared).toBe(false);
  });
});

describe("set-brain-model — pre-existing Claude-id paths (unchanged, regression check)", () => {
  beforeEach(() => {
    resetState();
  });

  it("empty string clears the override", async () => {
    const result = await setBrainModel.run({ model: "" });
    expect(result).toEqual({ brainModel: null, cleared: true });
    expect(putSetting).toHaveBeenCalledWith("brain-model", { model: "" });
  });

  it("accepts a valid accepted Claude model id", async () => {
    const result = await setBrainModel.run({ model: "claude-sonnet-5[1m]" });
    expect(result).toMatchObject({
      brainModel: "claude-sonnet-5[1m]",
      cleared: false,
    });
  });

  it("rejects an unaccepted Claude model id", async () => {
    await expect(
      setBrainModel.run({ model: "claude-haiku-nonexistent" }),
    ).rejects.toThrow(/Unsupported brain model/);
  });

  it("rejects a premium model under the default sonnet tier", async () => {
    await expect(
      setBrainModel.run({ model: "claude-opus-4-8" }),
    ).rejects.toThrow(/blocked by the current subscription tier/);
  });
});
