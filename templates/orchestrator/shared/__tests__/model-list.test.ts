import { describe, it, expect } from "vitest";
import {
  parseModelList,
  serializeModelList,
  pickerModelsFor,
} from "../model-list.js";

// P5 item4 (DESIGN §8.3 item4). The per-node model list comes from the saved
// runtime_configs row (`model` + the additive `models` column) — NOT a
// re-registered template engine. These pure helpers back that source.

describe("parseModelList", () => {
  it("parses a JSON array of model ids, trimming + de-duping", () => {
    expect(parseModelList('["a"," b ","a",""]')).toEqual(["a", "b"]);
  });
  it("null / empty / malformed → []", () => {
    expect(parseModelList(null)).toEqual([]);
    expect(parseModelList("")).toEqual([]);
    expect(parseModelList("not json")).toEqual([]);
    expect(parseModelList('{"x":1}')).toEqual([]);
    expect(parseModelList("[1,2,3]")).toEqual([]); // non-strings dropped
  });
});

describe("serializeModelList", () => {
  it("trims + de-dupes; empty → null (picker falls back to model)", () => {
    expect(serializeModelList(["a", " a ", "b", ""])).toBe('["a","b"]');
    expect(serializeModelList([])).toBeNull();
    expect(serializeModelList(undefined)).toBeNull();
    expect(serializeModelList(["   "])).toBeNull();
  });
});

describe("pickerModelsFor (default model + extra models, default first)", () => {
  it("union with the default model first, de-duped", () => {
    expect(
      pickerModelsFor("qwen3.6", ["llama3", "qwen3.6", "mixtral"]),
    ).toEqual(["qwen3.6", "llama3", "mixtral"]);
  });
  it("no extra models → just the default", () => {
    expect(pickerModelsFor("qwen3.6", [])).toEqual(["qwen3.6"]);
    expect(pickerModelsFor("qwen3.6", undefined)).toEqual(["qwen3.6"]);
  });
  it("no default + extras → the extras", () => {
    expect(pickerModelsFor(null, ["a", "b"])).toEqual(["a", "b"]);
    expect(pickerModelsFor("", ["a", "b"])).toEqual(["a", "b"]);
  });
  it("nothing → empty (picker shows a label-only option)", () => {
    expect(pickerModelsFor(null, undefined)).toEqual([]);
    expect(pickerModelsFor("  ", [" "])).toEqual([]);
  });
});
