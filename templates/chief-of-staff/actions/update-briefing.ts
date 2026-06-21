/**
 * Update a briefing's polished summary and/or title.
 *
 * Requires editor access (`assertAccess("briefing", id, "editor")`). This is
 * the only path the Chief-of-Staff agent uses to write the polished
 * `summaryMd` narrative (the AI-writes-prose rule lives here, not in a
 * compile-time LLM call). It is a mutating action — running it emits a
 * framework `action` change event, so open `list-briefings` / `get-briefing`
 * panels auto-refetch within one poll interval.
 *
 * Usage:
 *   pnpm action update-briefing --id=brief_abc123 --summaryMd="..." --title="..."
 */

import { defineAction } from "@agent-native/core";
import { assertAccess } from "@agent-native/core/sharing";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";

export default defineAction({
  description:
    "Update a briefing's polished summary (summaryMd) and/or title. Use this after compiling to write the agent-polished narrative, or to let the user rename a briefing. Requires editor access.",
  schema: z.object({
    id: z.string().describe("Briefing ID (required)"),
    summaryMd: z
      .string()
      .optional()
      .describe("New polished markdown summary for the briefing"),
    title: z.string().optional().describe("New briefing title"),
  }),
  run: async (args) => {
    await assertAccess("briefing", args.id, "editor");

    if (args.summaryMd === undefined && args.title === undefined) {
      throw new Error("Provide at least one of summaryMd or title to update.");
    }

    const now = new Date().toISOString();
    const updates: Record<string, unknown> = { updatedAt: now };
    if (args.summaryMd !== undefined) updates.summaryMd = args.summaryMd;
    if (args.title !== undefined) updates.title = args.title;

    const db = getDb();
    await db
      .update(schema.briefings)
      .set(updates)
      .where(eq(schema.briefings.id, args.id));

    const [row] = await db
      .select({
        id: schema.briefings.id,
        briefingDate: schema.briefings.briefingDate,
        kind: schema.briefings.kind,
        title: schema.briefings.title,
        summaryMd: schema.briefings.summaryMd,
        status: schema.briefings.status,
        focus: schema.briefings.focus,
        createdAt: schema.briefings.createdAt,
        updatedAt: schema.briefings.updatedAt,
        ownerEmail: schema.briefings.ownerEmail,
      })
      .from(schema.briefings)
      .where(eq(schema.briefings.id, args.id))
      .limit(1);

    if (!row) throw new Error(`Briefing ${args.id} not found`);
    return row;
  },
});
