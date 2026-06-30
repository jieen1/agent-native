import { defineAction } from "@agent-native/core";
import { getDb, schema } from "../server/db/index.js";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { ownerScope } from "../server/lib/access.js";
import { readAppStateForCurrentTab } from "./_tab-state.js";

const LIST_LIMIT = 25;

export default defineAction({
  description: "See what the user is currently looking at on screen.",
  schema: z.object({}),
  http: false,
  run: async () => {
    const navigation = await readAppStateForCurrentTab("navigation", {
      fallbackToGlobal: false,
    });

    const screen: Record<string, unknown> = {};
    if (navigation) screen.navigation = navigation;
    const nav = navigation as any;
    const db = getDb();

    // Always include a short project + work-item overview for grounding.
    try {
      const projects = await db
        .select({
          id: schema.projects.id,
          key: schema.projects.key,
          name: schema.projects.name,
          gitRemote: schema.projects.gitRemote,
          defaultBranch: schema.projects.defaultBranch,
        })
        .from(schema.projects)
        .where(ownerScope(schema.projects))
        .orderBy(desc(schema.projects.updatedAt))
        .limit(LIST_LIMIT);
      screen.projects = projects;
    } catch {
      // continue
    }

    try {
      const items = await db
        .select({
          id: schema.workItems.id,
          projectId: schema.workItems.projectId,
          title: schema.workItems.title,
          type: schema.workItems.type,
          status: schema.workItems.status,
          orchestratorThreadId: schema.workItems.orchestratorThreadId,
        })
        .from(schema.workItems)
        .where(ownerScope(schema.workItems))
        .orderBy(desc(schema.workItems.updatedAt))
        .limit(LIST_LIMIT);
      screen.workItems = items;
    } catch {
      // continue
    }

    // Focused work item detail when one is open.
    if (nav?.itemId) {
      try {
        const item = (
          await db
            .select()
            .from(schema.workItems)
            .where(
              and(
                eq(schema.workItems.id, nav.itemId),
                ownerScope(schema.workItems),
              ),
            )
            .limit(1)
        )[0];
        if (item) screen.openWorkItem = item;
      } catch {
        // continue
      }
    }

    if (Object.keys(screen).length === 0) {
      return "No application state found. Is the app running?";
    }
    return screen;
  },
});
