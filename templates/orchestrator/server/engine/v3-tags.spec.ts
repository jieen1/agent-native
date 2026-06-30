// V3 Tags Unit Tests
//
// Tests mergeTags and validateTagsFormat from v3-tags.ts.

import { describe, it, expect } from "vitest";
import { mergeTags, validateTagsFormat } from "./v3-tags.js";

describe("mergeTags", () => {
  it("returns null when both inputs are null/undefined", () => {
    expect(mergeTags(null, null)).toBeNull();
    expect(mergeTags(undefined, undefined)).toBeNull();
    expect(mergeTags(null, undefined)).toBeNull();
    expect(mergeTags(undefined, null)).toBeNull();
  });

  it("returns source tags when extraTags is null", () => {
    const source = { project: "alpha", env: "dev" };
    const result = mergeTags(source, null);
    expect(result).toEqual({ project: "alpha", env: "dev" });
  });

  it("returns extra tags when sourceTags is null", () => {
    const extra = { region: "us" };
    const result = mergeTags(null, extra);
    expect(result).toEqual({ region: "us" });
  });

  it("extraTags override sourceTags with same key", () => {
    const source = { project: "alpha", env: "dev", priority: "low" };
    const extra = { env: "prod", region: "us" };
    const result = mergeTags(source, extra);
    expect(result).toEqual({
      project: "alpha",
      env: "prod",
      priority: "low",
      region: "us",
    });
  });

  it("does not mutate source tags", () => {
    const source = { project: "alpha" };
    const extra = { env: "prod" };
    mergeTags(source, extra);
    expect(source).toEqual({ project: "alpha" });
    expect(extra).toEqual({ env: "prod" });
  });

  it("does not mutate extra tags", () => {
    const source = { project: "alpha" };
    const extra = { env: "prod" };
    const result = mergeTags(source, extra);
    expect(result).not.toBe(source);
    expect(result).not.toBe(extra);
  });

  it("handles well-known tag keys", () => {
    const source = { source_app: "orchestrator", source_run_id: "run-1" };
    const extra = { project_id: "proj-42", user_id: "user-1" };
    const result = mergeTags(source, extra);
    expect(result).toEqual({
      source_app: "orchestrator",
      source_run_id: "run-1",
      project_id: "proj-42",
      user_id: "user-1",
    });
  });

  it("handles empty extra tags object", () => {
    const source = { project: "alpha" };
    const result = mergeTags(source, {});
    expect(result).toEqual({ project: "alpha" });
  });

  it("allows extraTags to set undefined values", () => {
    const source = { project: "alpha" };
    const extra = { project: undefined as unknown as string };
    const result = mergeTags(source, extra);
    expect(result).toHaveProperty("project");
    expect(result!.project).toBeUndefined();
  });
});

describe("validateTagsFormat", () => {
  it("accepts valid plain object with string values", () => {
    expect(validateTagsFormat({ project: "alpha", env: "dev" })).toBeUndefined();
    expect(validateTagsFormat({})).toBeUndefined();
  });

  it("accepts object with undefined values", () => {
    expect(validateTagsFormat({ key: undefined })).toBeUndefined();
  });

  it("accepts object with null values", () => {
    expect(validateTagsFormat({ key: null as unknown })).toBeUndefined();
  });

  it("rejects null", () => {
    expect(validateTagsFormat(null)).toBe("Tags must be a plain object");
  });

  it("rejects arrays", () => {
    expect(validateTagsFormat(["a", "b"])).toBe("Tags must be a plain object");
  });

  it("rejects non-object primitives", () => {
    expect(validateTagsFormat("string")).toBe("Tags must be a plain object");
    expect(validateTagsFormat(42)).toBe("Tags must be a plain object");
    expect(validateTagsFormat(true)).toBe("Tags must be a plain object");
  });

  it("rejects non-string values", () => {
    expect(validateTagsFormat({ count: 42 })).toContain("must be a string");
    expect(validateTagsFormat({ flag: true })).toContain("must be a string");
    expect(validateTagsFormat({ obj: { nested: true } as unknown })).toContain(
      "must be a string",
    );
  });

  it("identifies the offending key in error message", () => {
    const err = validateTagsFormat({
      project: "alpha",
      count: 42,
    } as any);
    expect(err).toContain("count");
  });
});
