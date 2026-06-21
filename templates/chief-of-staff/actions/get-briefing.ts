/**
 * Get one briefing, including its full per-source detail.
 *
 * Enforces viewer access through `resolveAccess("briefing", id, "viewer")`; a
 * caller with no access gets a ForbiddenError (404-equivalent), never another
 * user's data.
 *
 * Usage:
 *   pnpm action get-briefing --id=brief_abc123
 */

import { defineAction } from "@agent-native/core";
import { ForbiddenError, resolveAccess } from "@agent-native/core/sharing";
import { z } from "zod";
import { schema } from "../server/db/index.js";
import type { BriefingSource } from "../shared/types.js";

export default defineAction({
  description:
    "Get one briefing by id, including its polished summary and the full per-source detail. Use this to open a briefing's detail page or answer questions about a specific briefing.",
  schema: z.object({
    id: z.string().describe("Briefing ID"),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ id }) => {
    const access = await resolveAccess("briefing", id);
    if (!access) throw new ForbiddenError(`Briefing ${id} not found`);

    const row = access.resource as typeof schema.briefings.$inferSelect;

    let sources: BriefingSource[] = [];
    try {
      sources = JSON.parse(row.sourcesJson) as BriefingSource[];
    } catch {
      sources = [];
    }

    return {
      id: row.id,
      briefingDate: row.briefingDate,
      kind: row.kind,
      title: row.title,
      summaryMd: row.summaryMd,
      sources,
      status: row.status,
      focus: row.focus ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ownerEmail: row.ownerEmail,
      visibility: row.visibility,
      role: access.role,
    };
  },
});
