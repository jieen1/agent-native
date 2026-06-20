import { describe, it, expect } from "vitest";
import {
  resolveNodeExecutorChoice,
  assertSystemDefaultValid,
  ConfigError,
  BUILTIN_ENGINES,
  type ExecutorChoiceContext,
} from "./executor-choice.js";

// A baseline context: one seeded runtime_config key, default builtin engines.
const baseCtx: ExecutorChoiceContext = {
  markerRuntime: null,
  runtimeConfigKeys: ["rt_abc"],
  builtinEngines: BUILTIN_ENGINES,
  systemDefault: null,
};

describe("resolveNodeExecutorChoice (pure core, D-7 priority)", () => {
  it("1. node.engine='claude-code' → { kind:'claude-code' }", () => {
    const result = resolveNodeExecutorChoice(
      { engine: "claude-code" },
      baseCtx,
    );
    expect(result).toEqual({ kind: "claude-code" });
  });

  it("2. node.engine = seeded runtime_config key → engine of that key", () => {
    const result = resolveNodeExecutorChoice({ engine: "rt_abc" }, baseCtx);
    expect(result).toEqual({ kind: "engine", engine: "rt_abc" });
  });

  it("3. node.engine = builtin id 'ai-sdk:openai' → engine ai-sdk:openai", () => {
    const result = resolveNodeExecutorChoice(
      { engine: "ai-sdk:openai" },
      baseCtx,
    );
    expect(result).toEqual({ kind: "engine", engine: "ai-sdk:openai" });
  });

  it("4. unknown / empty-string / no-default → throws ConfigError (never undefined)", () => {
    // unknown choice
    const unknown = () =>
      resolveNodeExecutorChoice({ engine: "nope" }, baseCtx);
    expect(unknown).toThrow(ConfigError);
    try {
      unknown();
      throw new Error("expected ConfigError for unknown choice");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).name).toBe("ConfigError");
    }

    // empty string node.engine, with no marker/default → still a ConfigError.
    // It must THROW, never return a value — the sentinel proves no return ran.
    const empty = () => resolveNodeExecutorChoice({ engine: "" }, baseCtx);
    expect(empty).toThrow(ConfigError);
    const sentinel = Symbol("not-assigned");
    let emptyReturned: unknown = sentinel;
    let emptyThrew = false;
    try {
      emptyReturned = empty();
    } catch {
      emptyThrew = true;
    }
    expect(emptyThrew).toBe(true);
    expect(emptyReturned).toBe(sentinel); // never returned undefined or a value
    try {
      empty();
      throw new Error("expected ConfigError for empty choice");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).name).toBe("ConfigError");
    }

    // whitespace-only is also empty
    const whitespace = () =>
      resolveNodeExecutorChoice({ engine: "   " }, baseCtx);
    expect(whitespace).toThrow(ConfigError);

    // no engine, no marker, no default → ConfigError
    const none = () => resolveNodeExecutorChoice({}, baseCtx);
    expect(none).toThrow(ConfigError);
  });

  it("5. D-7 override: node.engine='ai-sdk:openai' WITH markerRuntime='claude-code' → engine ai-sdk:openai (per-node beats marker)", () => {
    const result = resolveNodeExecutorChoice(
      { engine: "ai-sdk:openai" },
      { ...baseCtx, markerRuntime: "claude-code" },
    );
    expect(result).toEqual({ kind: "engine", engine: "ai-sdk:openai" });
  });

  it("6. marker default applies when node.engine empty: node={}, markerRuntime='claude-code' → claude-code", () => {
    const result = resolveNodeExecutorChoice(
      {},
      { ...baseCtx, markerRuntime: "claude-code" },
    );
    expect(result).toEqual({ kind: "claude-code" });
  });

  it("systemDefault applies when node.engine and marker are both empty", () => {
    const result = resolveNodeExecutorChoice(
      {},
      { ...baseCtx, markerRuntime: null, systemDefault: "rt_abc" },
    );
    expect(result).toEqual({ kind: "engine", engine: "rt_abc" });
  });
});

describe("assertSystemDefaultValid (startup validation)", () => {
  it("7a. real key passes (no throw): runtime_config key, builtin engine, claude-code, and null", async () => {
    await expect(
      assertSystemDefaultValid("rt_abc", ["rt_abc"]),
    ).resolves.toBeUndefined();
    await expect(
      assertSystemDefaultValid("ai-sdk:openai", ["rt_abc"]),
    ).resolves.toBeUndefined();
    await expect(
      assertSystemDefaultValid("claude-code", ["rt_abc"]),
    ).resolves.toBeUndefined();
    // null/empty means "no system default configured" — allowed.
    await expect(
      assertSystemDefaultValid(null, ["rt_abc"]),
    ).resolves.toBeUndefined();
    await expect(
      assertSystemDefaultValid("   ", ["rt_abc"]),
    ).resolves.toBeUndefined();
  });

  it("7b. bogus key throws ConfigError (no dangling magic string)", async () => {
    await expect(
      assertSystemDefaultValid("vllm-default", ["rt_abc"]),
    ).rejects.toBeInstanceOf(ConfigError);
    await expect(
      assertSystemDefaultValid("vllm-default", ["rt_abc"]),
    ).rejects.toMatchObject({ name: "ConfigError" });
  });
});
