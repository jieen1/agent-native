// getBrainRuntimeSelection — resolves the brain's per-owner engine choice from
// the (possibly runtime:<id>-prefixed) BRAIN_MODEL_KEY setting. Fully
// dependency-injected (mirrors RoutingRuntimeExecutorDeps's injectable-
// functions style) so this is a pure-logic unit test: no live DB, no settings
// store, no secrets vault.

import { describe, it, expect, vi } from "vitest";

import type { OwnerRuntimeRow } from "../runtime/executors/routing-runtime-executor.js";
import { getBrainRuntimeSelection } from "./brain-runtime.js";

const aliyunRow: OwnerRuntimeRow = {
  id: "rt_4ry56fwd1yj763f3",
  name: "Aliyun Bailian",
  kind: "openai-compatible",
  baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  model: "qwen3.8-max-preview",
  active: 1,
};

describe("getBrainRuntimeSelection", () => {
  it("returns the claude variant, calling getBrainModel(), when nothing is saved", async () => {
    const getBrainModel = vi.fn(async () => "claude-sonnet-5[1m]");
    const resolveOwnerRuntimeRow = vi.fn();

    const result = await getBrainRuntimeSelection("owner@example.com", {
      getRawBrainModelSetting: async () => "",
      getBrainModel,
      resolveOwnerRuntimeRow,
    });

    expect(result).toEqual({ kind: "claude", model: "claude-sonnet-5[1m]" });
    expect(getBrainModel).toHaveBeenCalledTimes(1);
    expect(resolveOwnerRuntimeRow).not.toHaveBeenCalled();
  });

  it("returns the claude variant for a plain Claude model id (no runtime: prefix)", async () => {
    const getBrainModel = vi.fn(async () => "claude-opus-4-8");
    const result = await getBrainRuntimeSelection("owner@example.com", {
      getRawBrainModelSetting: async () => "claude-opus-4-8",
      getBrainModel,
      resolveOwnerRuntimeRow: vi.fn(),
    });
    expect(result).toEqual({ kind: "claude", model: "claude-opus-4-8" });
  });

  it("resolves a valid runtime: selector to the 'runtime' variant with the row's baseUrl/model/name + resolved apiKey", async () => {
    const resolveOwnerRuntimeRow = vi.fn(async (owner: string, id: string) => {
      expect(owner).toBe("owner@example.com");
      expect(id).toBe(aliyunRow.id);
      return aliyunRow;
    });
    const resolveApiKey = vi.fn(async () => "sk-real-aliyun-key");

    const result = await getBrainRuntimeSelection("owner@example.com", {
      getRawBrainModelSetting: async () => `runtime:${aliyunRow.id}`,
      resolveOwnerRuntimeRow,
      resolveApiKey,
    });

    expect(result).toEqual({
      kind: "runtime",
      runtimeConfigId: aliyunRow.id,
      name: aliyunRow.name,
      baseUrl: aliyunRow.baseUrl,
      model: aliyunRow.model,
      apiKey: "sk-real-aliyun-key",
    });
  });

  it("resolves with apiKey undefined when the row never configured one", async () => {
    const result = await getBrainRuntimeSelection("owner@example.com", {
      getRawBrainModelSetting: async () => `runtime:${aliyunRow.id}`,
      resolveOwnerRuntimeRow: async () => aliyunRow,
      resolveApiKey: async () => undefined,
    });
    expect(result.kind).toBe("runtime");
    if (result.kind === "runtime") expect(result.apiKey).toBeUndefined();
  });

  it("returns 'runtime-unresolved' when the row no longer exists (deleted / wrong owner)", async () => {
    const result = await getBrainRuntimeSelection("owner@example.com", {
      getRawBrainModelSetting: async () => "runtime:rt_deleted",
      resolveOwnerRuntimeRow: async () => undefined,
      resolveApiKey: vi.fn(),
    });
    expect(result).toEqual({
      kind: "runtime-unresolved",
      runtimeConfigId: "rt_deleted",
    });
  });

  it("returns 'runtime-unresolved' for a claude-code-kind row (never a real endpoint)", async () => {
    const ccRow: OwnerRuntimeRow = {
      id: "rt_cc",
      name: "Claude Code",
      kind: "claude-code",
      baseUrl: null,
      model: null,
      active: 1,
    };
    const result = await getBrainRuntimeSelection("owner@example.com", {
      getRawBrainModelSetting: async () => "runtime:rt_cc",
      resolveOwnerRuntimeRow: async () => ccRow,
    });
    expect(result).toEqual({
      kind: "runtime-unresolved",
      runtimeConfigId: "rt_cc",
    });
  });

  it("returns 'runtime-unresolved' when the row is missing baseUrl", async () => {
    const row: OwnerRuntimeRow = { ...aliyunRow, baseUrl: null };
    const result = await getBrainRuntimeSelection("owner@example.com", {
      getRawBrainModelSetting: async () => `runtime:${row.id}`,
      resolveOwnerRuntimeRow: async () => row,
    });
    expect(result).toEqual({
      kind: "runtime-unresolved",
      runtimeConfigId: row.id,
    });
  });

  it("returns 'runtime-unresolved' when the row is missing model", async () => {
    const row: OwnerRuntimeRow = { ...aliyunRow, model: null };
    const result = await getBrainRuntimeSelection("owner@example.com", {
      getRawBrainModelSetting: async () => `runtime:${row.id}`,
      resolveOwnerRuntimeRow: async () => row,
    });
    expect(result).toEqual({
      kind: "runtime-unresolved",
      runtimeConfigId: row.id,
    });
  });

  it("degrades to 'runtime-unresolved' when the row lookup throws (never blocks the turn)", async () => {
    const result = await getBrainRuntimeSelection("owner@example.com", {
      getRawBrainModelSetting: async () => "runtime:rt_boom",
      resolveOwnerRuntimeRow: async () => {
        throw new Error("db unavailable");
      },
    });
    expect(result).toEqual({
      kind: "runtime-unresolved",
      runtimeConfigId: "rt_boom",
    });
  });

  it("degrades to the claude variant when the raw setting read itself throws", async () => {
    const getBrainModel = vi.fn(async () => "claude-sonnet-5[1m]");
    const result = await getBrainRuntimeSelection("owner@example.com", {
      getRawBrainModelSetting: async () => {
        throw new Error("settings unavailable");
      },
      getBrainModel,
    });
    expect(result).toEqual({ kind: "claude", model: "claude-sonnet-5[1m]" });
  });

  it("resolves with apiKey undefined when resolveApiKey itself throws (never blocks the turn)", async () => {
    const result = await getBrainRuntimeSelection("owner@example.com", {
      getRawBrainModelSetting: async () => `runtime:${aliyunRow.id}`,
      resolveOwnerRuntimeRow: async () => aliyunRow,
      resolveApiKey: async () => {
        throw new Error("secret read failed");
      },
    });
    expect(result.kind).toBe("runtime");
    if (result.kind === "runtime") expect(result.apiKey).toBeUndefined();
  });
});
