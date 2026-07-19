// Brain runtime-switching (additive feature): a saved brain-model override can
// ALSO be a `runtime:<id>` selector pointing at a saved openai-compatible/vllm
// runtime_configs row, instead of a Claude model id. `parseRuntimeModelSelector`
// is the pure parser; `getRawBrainModelSetting`/`getBrainModel` are the two
// settings readers this feature must keep in perfect agreement (the raw value
// vs. the Claude-only degraded value) — this file proves BOTH the new parser
// AND that `getBrainModel()`'s existing degrade-to-default behavior is
// byte-identical to before this refactor.

import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  return { store };
});

vi.mock("@agent-native/core/settings", () => ({
  getSetting: vi.fn(async (key: string) => hoisted.store.get(key) ?? null),
  putSetting: vi.fn(async (key: string, value: unknown) => {
    hoisted.store.set(key, value);
  }),
}));

import { getSetting } from "@agent-native/core/settings";

import {
  BRAIN_MODEL_KEY,
  RUNTIME_MODEL_PREFIX,
  DEFAULT_BRAIN_MODEL,
  parseRuntimeModelSelector,
  getRawBrainModelSetting,
  getBrainModel,
} from "./brain-model.js";

describe("parseRuntimeModelSelector (pure)", () => {
  it("returns the id for a well-formed runtime:<id> value", () => {
    expect(parseRuntimeModelSelector("runtime:rt_4ry56fwd1yj763f3")).toBe(
      "rt_4ry56fwd1yj763f3",
    );
  });

  it("returns null for a plain Claude model id", () => {
    expect(parseRuntimeModelSelector("claude-sonnet-5[1m]")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseRuntimeModelSelector("")).toBeNull();
  });

  it("returns null for the prefix alone with no id (empty suffix)", () => {
    expect(parseRuntimeModelSelector(RUNTIME_MODEL_PREFIX)).toBeNull();
    expect(parseRuntimeModelSelector("runtime:")).toBeNull();
    expect(parseRuntimeModelSelector("runtime:   ")).toBeNull();
  });

  it("trims whitespace around the id suffix", () => {
    expect(parseRuntimeModelSelector("runtime:  rt_abc  ")).toBe("rt_abc");
  });

  it("does not match a value that merely CONTAINS the prefix mid-string", () => {
    expect(parseRuntimeModelSelector("some-runtime:rt_abc")).toBeNull();
  });
});

describe("getRawBrainModelSetting / getBrainModel (settings-backed)", () => {
  beforeEach(() => {
    hoisted.store.clear();
    vi.clearAllMocks();
  });

  it("getRawBrainModelSetting returns '' when nothing is saved", async () => {
    expect(await getRawBrainModelSetting()).toBe("");
  });

  it("getRawBrainModelSetting returns the trimmed raw value, INCLUDING a runtime: selector", async () => {
    hoisted.store.set(BRAIN_MODEL_KEY, { model: "  runtime:rt_abc123  " });
    expect(await getRawBrainModelSetting()).toBe("runtime:rt_abc123");
  });

  it("getRawBrainModelSetting degrades a throwing getSetting to ''", async () => {
    vi.mocked(getSetting).mockRejectedValueOnce(new Error("db down"));
    expect(await getRawBrainModelSetting()).toBe("");
  });

  it("getBrainModel is UNCHANGED: a runtime: selector still degrades to DEFAULT_BRAIN_MODEL (backward-safe by construction)", async () => {
    hoisted.store.set(BRAIN_MODEL_KEY, { model: "runtime:rt_abc123" });
    expect(await getBrainModel()).toBe(DEFAULT_BRAIN_MODEL);
  });

  it("getBrainModel is UNCHANGED: nothing saved -> DEFAULT_BRAIN_MODEL", async () => {
    expect(await getBrainModel()).toBe(DEFAULT_BRAIN_MODEL);
  });

  it("getBrainModel is UNCHANGED: a valid accepted Claude id round-trips", async () => {
    hoisted.store.set(BRAIN_MODEL_KEY, { model: "claude-opus-4-8" });
    expect(await getBrainModel()).toBe("claude-opus-4-8");
  });

  it("getBrainModel is UNCHANGED: a throwing getSetting degrades to DEFAULT_BRAIN_MODEL", async () => {
    vi.mocked(getSetting).mockRejectedValueOnce(new Error("db down"));
    expect(await getBrainModel()).toBe(DEFAULT_BRAIN_MODEL);
  });
});
