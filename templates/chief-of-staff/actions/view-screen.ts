/**
 * See what the user is currently looking at on screen.
 *
 * Reads the current navigation state from application state and, when the user
 * is viewing a specific briefing (navigation carries `briefingId`), loads that
 * briefing's summary so the agent can answer "about this briefing" questions.
 * Returns a structured object — callers should assert on the structure, not on
 * any particular wording.
 *
 * Usage:
 *   pnpm action view-screen
 */

import { defineAction } from "@agent-native/core";
import { readAppState } from "@agent-native/core/application-state";
import { accessFilter, resolveAccess } from "@agent-native/core/sharing";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import type { BriefingSource, BriefingSummary } from "../shared/types.js";

interface BriefingScreen {
  id: string;
  briefingDate: string;
  kind: string;
  title: string;
  summaryMd: string;
  status: string;
  focus: string | null;
  sourceApps: string[];
  okSourceCount: number;
}

export default defineAction({
  description:
    "See what the user is currently looking at on screen, including which briefing is open and a summary of recent briefings. Always call this first before taking any action.",
  schema: z.object({}),
  http: false,
  readOnly: true,
  run: async () => {
    const navigation = await readAppState("navigation");

    const screen: Record<string, unknown> = {};
    if (navigation) screen.navigation = navigation;

    const nav = navigation as {
      view?: string;
      briefingId?: string;
      date?: string;
    } | null;

    // When the user is looking at a specific briefing, load it (scoped through
    // resolveAccess so we never surface another user's data).
    if (nav?.briefingId) {
      try {
        const access = await resolveAccess("briefing", nav.briefingId);
        if (access) {
          const row = access.resource as typeof schema.briefings.$inferSelect;
          let sources: BriefingSource[] = [];
          try {
            sources = JSON.parse(row.sourcesJson) as BriefingSource[];
          } catch {
            sources = [];
          }
          const briefingSummary: BriefingScreen = {
            id: row.id,
            briefingDate: row.briefingDate,
            kind: row.kind,
            title: row.title,
            summaryMd: row.summaryMd,
            status: row.status,
            focus: row.focus ?? null,
            sourceApps: sources.map((s) => s.app),
            okSourceCount: sources.filter((s) => s.status === "ok").length,
          };
          screen.currentBriefingId = row.id;
          screen.briefingSummary = briefingSummary;
        } else {
          screen.briefingError = `Could not load briefing ${nav.briefingId}`;
        }
      } catch {
        screen.briefingError = `Could not load briefing ${nav.briefingId}`;
      }
    }

    // Always include a lean list of recent briefings for context. Project only
    // summary columns — never the sources_json blob.
    try {
      const accessWhere = accessFilter(schema.briefings, schema.briefingShares);
      const where = nav?.date
        ? and(accessWhere, eq(schema.briefings.briefingDate, nav.date))
        : accessWhere;
      const rows: BriefingSummary[] = await getDb()
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
        )
        .limit(12);
      screen.briefingsList = rows;
    } catch {
      // continue without list detail
    }

    if (Object.keys(screen).length === 0) {
      return "No application state found. Is the app running?";
    }
    return screen;
  },
});
