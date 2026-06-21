/**
 * List the current user's briefings, most recent first.
 *
 * Scoped through `accessFilter` so a caller only ever sees briefings they own
 * or have been shared. Optionally filter to a single `date` (YYYY-MM-DD).
 *
 * Usage:
 *   pnpm action list-briefings
 *   pnpm action list-briefings --date=2026-06-20
 */

import { defineAction } from "@agent-native/core";
import { accessFilter } from "@agent-native/core/sharing";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import type { BriefingSummary } from "../shared/types.js";

export default defineAction({
  description:
    "List the current user's briefings, most recent first. Optionally filter to a single date (YYYY-MM-DD). Use this to find the latest briefing for the today panel or to browse history.",
  schema: z.object({
    date: z
      .string()
      .optional()
      .describe("Filter to a single briefing date (YYYY-MM-DD). Omit for all."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args): Promise<BriefingSummary[]> => {
    // ctx defaults to currentAccess() inside accessFilter.
    const accessWhere = accessFilter(schema.briefings, schema.briefingShares);
    const where = args.date
      ? and(accessWhere, eq(schema.briefings.briefingDate, args.date))
      : accessWhere;

    // Project only list columns — never select the (potentially large)
    // sources_json blob for a list view.
    const rows = await getDb()
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
      .where(where)
      .orderBy(
        desc(schema.briefings.briefingDate),
        desc(schema.briefings.createdAt),
      );

    return rows;
  },
});
