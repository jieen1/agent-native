import type { ActionTool } from "../../agent/types.js";

export function dbExecToolParameters(): NonNullable<ActionTool["parameters"]> {
  return {
    type: "object",
    properties: {
      sql: {
        type: "string",
        description:
          "Single INSERT / UPDATE / DELETE / REPLACE statement. Use parameterized placeholders (?) where possible.",
      },
      args: {
        type: "string",
        description:
          'Optional JSON array of positional bind args for `sql`. Example: \'["published","form-123"]\'',
      },
      statements: {
        type: "string",
        description:
          'Optional JSON array of write statements to execute in one transaction. Prefer this over multiple db-exec calls. Example: \'[{"sql":"INSERT INTO notes (id,title) VALUES (?,?)","args":["n1","One"]},{"sql":"UPDATE counters SET value = value + 1 WHERE key = ?","args":["notes"]}]\'',
      },
      format: {
        type: "string",
        description: 'Output format: "json" or "text" (default: text)',
        enum: ["json", "text"],
      },
    },
    additionalProperties: false,
    // CORE-PATCHES.md #3: no top-level oneOf/anyOf/allOf here. The Anthropic
    // Messages API rejects any tool whose input_schema carries a top-level
    // combinator ("input_schema does not support oneOf, allOf, or anyOf at
    // the top level"), which broke every Claude Code brain/MCP turn that
    // included this tool. The either-`sql`-or-`statements` rule is documented
    // in the field descriptions and still enforced at run() time.
  };
}
