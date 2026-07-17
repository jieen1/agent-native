/**
 * Pure helpers backing the judgment-node `output_schema` structured editor
 * (r4 doc §4.5 gap #2 — "判断节点的 output_schema 以结构化编辑器呈现（enum 字段
 * 一等呈现）"). Kept side-effect-free and independent of React so the
 * add/remove/reorder/parse/serialize logic can be unit tested directly.
 *
 * `parseOutputSchemaProperties` is deliberately conservative: any schema
 * shape it doesn't fully recognize (a `$ref`, a nested `object`/`array`
 * `items`, a non-string `enum`, anything beyond `{type, required,
 * properties}` at the top level or `{type, enum}` per property) reports
 * `structurable: false` rather than guessing — the editor falls back to raw
 * JSON in that case instead of silently dropping fields it can't round-trip.
 */

const KNOWN_PROPERTY_TYPES = [
  "string",
  "number",
  "boolean",
  "array",
  "object",
] as const;

export type SchemaPropertyType = (typeof KNOWN_PROPERTY_TYPES)[number];

export interface SchemaPropertyDraft {
  name: string;
  type: SchemaPropertyType;
  required: boolean;
  /** Only meaningful (and only ever rendered) for `type === "string"`. */
  enumValues?: string[];
}

export interface ParsedOutputSchema {
  /** False when `schema` uses a shape the structured editor can't fully
   *  represent — callers should fall back to raw JSON rather than risk
   *  losing data on the next structured-editor commit. */
  structurable: boolean;
  properties: SchemaPropertyDraft[];
}

const isKnownType = (t: unknown): t is SchemaPropertyType =>
  typeof t === "string" &&
  (KNOWN_PROPERTY_TYPES as readonly string[]).includes(t);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const UNSTRUCTURABLE: ParsedOutputSchema = {
  structurable: false,
  properties: [],
};

export function parseOutputSchemaProperties(
  schema: unknown,
): ParsedOutputSchema {
  if (schema == null) return { structurable: true, properties: [] };
  if (!isPlainObject(schema)) return UNSTRUCTURABLE;

  const allowedTopKeys = new Set(["type", "required", "properties"]);
  if (Object.keys(schema).some((k) => !allowedTopKeys.has(k))) {
    return UNSTRUCTURABLE;
  }
  if (schema.type !== undefined && schema.type !== "object") {
    return UNSTRUCTURABLE;
  }
  if (schema.required !== undefined && !Array.isArray(schema.required)) {
    return UNSTRUCTURABLE;
  }
  const requiredList = Array.isArray(schema.required)
    ? schema.required.filter((r): r is string => typeof r === "string")
    : [];

  if (schema.properties === undefined) {
    return { structurable: true, properties: [] };
  }
  if (!isPlainObject(schema.properties)) return UNSTRUCTURABLE;

  const properties: SchemaPropertyDraft[] = [];
  for (const [name, raw] of Object.entries(schema.properties)) {
    if (!isPlainObject(raw)) return UNSTRUCTURABLE;
    const allowedPropKeys = new Set(["type", "enum"]);
    if (Object.keys(raw).some((k) => !allowedPropKeys.has(k))) {
      return UNSTRUCTURABLE;
    }
    if (!isKnownType(raw.type)) return UNSTRUCTURABLE;

    let enumValues: string[] | undefined;
    if (raw.enum !== undefined) {
      if (
        raw.type !== "string" ||
        !Array.isArray(raw.enum) ||
        !raw.enum.every((v) => typeof v === "string")
      ) {
        return UNSTRUCTURABLE;
      }
      // Present-but-empty `enum: []` still means "enum mode, no values yet"
      // (distinct from an absent `enum` key, which means "not an enum") —
      // preserve it as `enumValues: []`, not `undefined`.
      enumValues = raw.enum as string[];
    }

    properties.push({
      name,
      type: raw.type,
      required: requiredList.includes(name),
      enumValues,
    });
  }

  return { structurable: true, properties };
}

/** Inverse of `parseOutputSchemaProperties`. Named properties only — a blank
 *  name is treated as "not yet filled in" and dropped rather than emitted as
 *  a schema key. Returns `undefined` (no output_schema) when there are no
 *  named properties left, mirroring the raw-JSON field's "empty text ⇒
 *  undefined" convention. Duplicate names simply overwrite in the emitted
 *  `properties` object (last one in array order wins), matching plain object
 *  literal semantics — the editor generates unique placeholder names for new
 *  rows, so a collision only happens if the user renames one by hand. */
export function serializeOutputSchemaProperties(
  properties: SchemaPropertyDraft[],
): unknown {
  const named = properties.filter((p) => p.name.trim().length > 0);
  if (named.length === 0) return undefined;

  const required = named.filter((p) => p.required).map((p) => p.name);
  const propsOut: Record<string, unknown> = {};
  for (const p of named) {
    // `enumValues !== undefined` (not `.length > 0`) — a freshly-toggled
    // enum field starts with zero values and must still emit a real (if
    // empty) `enum` key, or the next parse reads it back as a plain string
    // and the toggle silently reverts.
    propsOut[p.name] =
      p.type === "string" && p.enumValues !== undefined
        ? { type: "string", enum: p.enumValues }
        : { type: p.type };
  }

  return {
    type: "object",
    ...(required.length > 0 ? { required } : {}),
    properties: propsOut,
  };
}

/** Generates the next unused `field1`/`field2`/… placeholder name for a new
 *  property row, so a fresh row is never born with a colliding blank name. */
export function nextPropertyName(existing: Iterable<string>): string {
  const taken = new Set(existing);
  let n = 1;
  while (taken.has(`field${n}`)) n++;
  return `field${n}`;
}

/** Move an array item from one index to another, returning a new array.
 *  Used by both the human_gate `options[]` editor and the output_schema
 *  enum-values editor for their drag-to-reorder interaction — a no-op
 *  (returns the same array reference) for an out-of-range or identity move. */
export function reorderArray<T>(
  arr: readonly T[],
  fromIndex: number,
  toIndex: number,
): T[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= arr.length ||
    toIndex >= arr.length
  ) {
    return arr as T[];
  }
  const next = [...arr];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}
