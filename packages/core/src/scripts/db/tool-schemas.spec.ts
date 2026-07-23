import { describe, expect, it } from "vitest";

import { dbExecToolParameters } from "./tool-schemas.js";

// Stale test fixed 2026-07-23 (CI noise audit, SDLC-096): this used to assert
// a top-level `oneOf` combinator, but CORE-PATCHES.md #3 deliberately removed
// it — the Anthropic Messages API rejects any tool whose input_schema carries
// a top-level oneOf/allOf/anyOf. The either-sql-or-statements exclusivity is
// real and still enforced (see scripts/db/exec.ts's `fail("Pass either --sql
// or --statements, not both.")`), just not expressible in the schema itself;
// it's documented in the field descriptions instead. This test now locks the
// schema's ACTUAL shape instead of a combinator the implementation can never
// have.
describe("dbExecToolParameters", () => {
  it("has no top-level combinator (Anthropic tool schema constraint) and documents the sql/statements exclusivity in field descriptions instead", () => {
    const schema = dbExecToolParameters();
    expect(schema).not.toHaveProperty("oneOf");
    expect(schema).not.toHaveProperty("anyOf");
    expect(schema).not.toHaveProperty("allOf");
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect(schema.properties?.sql).toBeDefined();
    expect(schema.properties?.statements).toBeDefined();
    expect(
      (schema.properties?.sql as { description?: string })?.description,
    ).toMatch(/single/i);
    expect(
      (schema.properties?.statements as { description?: string })?.description,
    ).toMatch(/transaction/i);
  });
});
