// output-schema-editor — parse/serialize/reorder helpers behind the
// judgment-node output_schema structured editor (r4 doc §4.5 gap #2).
//
// The load-bearing invariant these tests pin: any schema shape the
// structured editor can't fully round-trip must report `structurable:
// false` so the UI falls back to raw JSON instead of silently dropping
// fields on the next commit.

import { describe, it, expect } from "vitest";

import {
  parseOutputSchemaProperties,
  serializeOutputSchemaProperties,
  nextPropertyName,
  reorderArray,
  type SchemaPropertyDraft,
} from "./output-schema-editor.js";

describe("parseOutputSchemaProperties", () => {
  it("treats a missing schema as structurable with zero properties", () => {
    expect(parseOutputSchemaProperties(undefined)).toEqual({
      structurable: true,
      properties: [],
    });
    expect(parseOutputSchemaProperties(null)).toEqual({
      structurable: true,
      properties: [],
    });
  });

  it("parses a real production judgment schema (audit3-style verdict enum)", () => {
    const schema = {
      type: "object",
      required: ["verdict"],
      properties: {
        verdict: { type: "string", enum: ["NO_GAPS", "GAPS_FOUND"] },
        gaps: { type: "array" },
        metrics: { type: "array" },
      },
    };
    expect(parseOutputSchemaProperties(schema)).toEqual({
      structurable: true,
      properties: [
        {
          name: "verdict",
          type: "string",
          required: true,
          enumValues: ["NO_GAPS", "GAPS_FOUND"],
        },
        { name: "gaps", type: "array", required: false, enumValues: undefined },
        {
          name: "metrics",
          type: "array",
          required: false,
          enumValues: undefined,
        },
      ],
    });
  });

  it("falls back to unstructurable for a non-object top-level schema", () => {
    expect(
      parseOutputSchemaProperties({ type: "array", items: { type: "string" } }),
    ).toEqual({ structurable: false, properties: [] });
  });

  it("falls back to unstructurable for a property with an unrecognized key (e.g. pattern)", () => {
    expect(
      parseOutputSchemaProperties({
        type: "object",
        properties: { x: { type: "string", pattern: "^a" } },
      }),
    ).toEqual({ structurable: false, properties: [] });
  });

  it("falls back to unstructurable for a nested object/array property shape", () => {
    expect(
      parseOutputSchemaProperties({
        type: "object",
        properties: { nested: { type: "object", properties: {} } },
      }),
    ).toEqual({ structurable: false, properties: [] });
  });

  it("falls back to unstructurable for a non-string enum value", () => {
    expect(
      parseOutputSchemaProperties({
        type: "object",
        properties: { count: { type: "number", enum: [1, 2] } },
      }),
    ).toEqual({ structurable: false, properties: [] });
  });

  it("falls back to unstructurable for a non-string type carrying a string-array enum (e.g. boolean)", () => {
    expect(
      parseOutputSchemaProperties({
        type: "object",
        properties: { flag: { type: "boolean", enum: ["yes", "no"] } },
      }),
    ).toEqual({ structurable: false, properties: [] });
  });

  it("falls back to unstructurable for an unrecognized top-level key ($ref etc.)", () => {
    expect(
      parseOutputSchemaProperties({ type: "object", $ref: "#/definitions/x" }),
    ).toEqual({ structurable: false, properties: [] });
  });

  it("parses a present-but-empty `enum: []` as enumValues: [] (still enum mode), distinct from an absent enum key", () => {
    expect(
      parseOutputSchemaProperties({
        type: "object",
        properties: {
          verdict: { type: "string", enum: [] },
          plain: { type: "string" },
        },
      }),
    ).toEqual({
      structurable: true,
      properties: [
        { name: "verdict", type: "string", required: false, enumValues: [] },
        {
          name: "plain",
          type: "string",
          required: false,
          enumValues: undefined,
        },
      ],
    });
  });
});

describe("serializeOutputSchemaProperties", () => {
  it("returns undefined for zero named properties", () => {
    expect(serializeOutputSchemaProperties([])).toBeUndefined();
    expect(
      serializeOutputSchemaProperties([
        { name: "  ", type: "string", required: false },
      ]),
    ).toBeUndefined();
  });

  it("emits an enum verdict field plus a plain required string, matching the real seed shape", () => {
    const properties: SchemaPropertyDraft[] = [
      {
        name: "verdict",
        type: "string",
        required: true,
        enumValues: ["approved", "changes_requested"],
      },
      { name: "summary", type: "string", required: true },
      { name: "issues", type: "array", required: false },
    ];
    expect(serializeOutputSchemaProperties(properties)).toEqual({
      type: "object",
      required: ["verdict", "summary"],
      properties: {
        verdict: { type: "string", enum: ["approved", "changes_requested"] },
        summary: { type: "string" },
        issues: { type: "array" },
      },
    });
  });

  it("omits `required` entirely when no property is required", () => {
    const result = serializeOutputSchemaProperties([
      { name: "note", type: "string", required: false },
    ]) as Record<string, unknown>;
    expect(result.required).toBeUndefined();
    expect(result.properties).toEqual({ note: { type: "string" } });
  });

  it("round-trips through parse → serialize → parse without loss", () => {
    const schema = {
      type: "object",
      required: ["verdict"],
      properties: {
        verdict: { type: "string", enum: ["ok", "fail"] },
        note: { type: "string" },
      },
    };
    const parsed = parseOutputSchemaProperties(schema);
    expect(parsed.structurable).toBe(true);
    const serialized = serializeOutputSchemaProperties(parsed.properties);
    expect(parseOutputSchemaProperties(serialized)).toEqual(parsed);
  });

  it("emits a real (if empty) `enum: []` key for a freshly-toggled enum field with zero values, not a plain string", () => {
    const result = serializeOutputSchemaProperties([
      { name: "verdict", type: "string", required: false, enumValues: [] },
    ]) as Record<string, unknown>;
    expect(result.properties).toEqual({
      verdict: { type: "string", enum: [] },
    });
  });
});

// Regression test for the reported bug: clicking "设为枚举 (enum)" on a plain
// string field set `enumValues: []` to enter enum mode, but serialize used
// to gate the `enum` key on `.length > 0` and drop it — so the very next
// parse (the same render cycle the UI actually does on every commit) read
// back a schema with no `enum` key, set `enumValues: undefined`, and
// `isEnum` (`type === "string" && enumValues !== undefined`) flipped back to
// false. The toggle looked like a no-op and there was no way to create a
// brand-new enum field through the structured editor.
describe("toggle-to-enum UI flow (regression)", () => {
  it("stays in enum mode across a full toggle → serialize → re-parse cycle with zero values", () => {
    // Start: a plain string field, never an enum (state a).
    const plain: SchemaPropertyDraft = {
      name: "verdict",
      type: "string",
      required: false,
      enumValues: undefined,
    };
    const isEnum = (p: SchemaPropertyDraft) =>
      p.type === "string" && p.enumValues !== undefined;
    expect(isEnum(plain)).toBe(false);

    // Click "设为枚举 (enum)" — enters enum mode with zero values (state b).
    const toggledOn: SchemaPropertyDraft = { ...plain, enumValues: [] };
    expect(isEnum(toggledOn)).toBe(true);

    // The editor commits on every change: serialize the draft list, then
    // the next render re-parses `value` from scratch (the real UI path —
    // `parsed` is recomputed from the committed schema, not cached).
    const committed = serializeOutputSchemaProperties([toggledOn]);
    const reparsed = parseOutputSchemaProperties(committed);
    expect(reparsed.structurable).toBe(true);
    expect(reparsed.properties).toHaveLength(1);
    const roundTripped = reparsed.properties[0]!;
    expect(roundTripped).toEqual({
      name: "verdict",
      type: "string",
      required: false,
      enumValues: [],
    });
    // The toggle must not have silently reverted.
    expect(isEnum(roundTripped)).toBe(true);
  });

  it("preserves the first added enum value through a second commit → re-parse cycle", () => {
    // Continuing from the empty-enum state above, the realistic next step:
    // the user types a value into the now-visible chip-list editor.
    const afterToggle: SchemaPropertyDraft = {
      name: "verdict",
      type: "string",
      required: false,
      enumValues: [],
    };
    const withFirstValue: SchemaPropertyDraft = {
      ...afterToggle,
      enumValues: ["approved"],
    };

    const committed = serializeOutputSchemaProperties([withFirstValue]);
    expect(committed).toEqual({
      type: "object",
      properties: { verdict: { type: "string", enum: ["approved"] } },
    });

    const reparsed = parseOutputSchemaProperties(committed);
    expect(reparsed).toEqual({
      structurable: true,
      properties: [
        {
          name: "verdict",
          type: "string",
          required: false,
          enumValues: ["approved"],
        },
      ],
    });
  });
});

describe("nextPropertyName", () => {
  it("picks field1 when nothing is taken", () => {
    expect(nextPropertyName([])).toBe("field1");
  });

  it("skips names already in use", () => {
    expect(nextPropertyName(["field1", "field2"])).toBe("field3");
    expect(nextPropertyName(["field2"])).toBe("field1");
  });
});

describe("reorderArray", () => {
  it("moves an item from one index to another", () => {
    expect(reorderArray(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(reorderArray(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });

  it("is a no-op for an identity move", () => {
    const arr = ["a", "b"];
    expect(reorderArray(arr, 1, 1)).toEqual(["a", "b"]);
  });

  it("is a no-op for an out-of-range index", () => {
    const arr = ["a", "b"];
    expect(reorderArray(arr, -1, 1)).toBe(arr);
    expect(reorderArray(arr, 0, 5)).toBe(arr);
  });
});
