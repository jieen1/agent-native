import { defineAction } from "@agent-native/core";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import { buildInboxGroups } from "../server/lib/inbox.js";
import { getSchedulerState } from "../server/lib/scheduler-gate.js";
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

    // Sprint focus when viewing a sprint detail page.
    if (nav?.view === "sprint" && nav?.sprintId) {
      try {
        const sprintRows = await db
          .select()
          .from(schema.sprints)
          .where(
            and(
              eq(schema.sprints.id, nav.sprintId),
              ownerScope(schema.sprints),
            ),
          )
          .limit(1);
        if (sprintRows[0]) {
          const sprint = sprintRows[0];
          const items = await db
            .select({
              id: schema.workItems.id,
              title: schema.workItems.title,
              type: schema.workItems.type,
              status: schema.workItems.status,
              currentStageName: schema.workItems.currentStageName,
            })
            .from(schema.workItems)
            .where(eq(schema.workItems.sprintId, nav.sprintId));
          screen.openSprint = {
            id: sprint.id,
            projectId: sprint.projectId,
            name: sprint.name,
            goal: sprint.goal,
            status: sprint.status,
            phase: sprint.phase,
            itemCount: items.length,
            delivered: items.filter((i) => i.status === "done").length,
            items,
          };
        }
      } catch {
        // continue
      }
    }

    // Queue focus when viewing the queue page.
    if (nav?.view === "queue") {
      try {
        const allQueueRows = await db
          .select()
          .from(schema.execQueue)
          .where(ownerScope(schema.execQueue))
          .orderBy(
            desc(schema.execQueue.priority),
            asc(schema.execQueue.enqueuedAt),
          )
          .limit(500);

        const stats = {
          queued: allQueueRows.filter((r) => r.status === "queued").length,
          running: allQueueRows.filter((r) => r.status === "running").length,
          paused: allQueueRows.filter((r) => r.status === "paused").length,
        };

        const topRows = allQueueRows.slice(0, 10);
        const enrichedItems = await Promise.all(
          topRows.map(async (queueRow) => {
            const wiRows = await db
              .select({
                id: schema.workItems.id,
                title: schema.workItems.title,
                type: schema.workItems.type,
                status: schema.workItems.status,
              })
              .from(schema.workItems)
              .where(eq(schema.workItems.id, queueRow.workItemId))
              .limit(1);
            return { ...queueRow, workItem: wiRows[0] ?? null };
          }),
        );

        const scheduler = await getSchedulerState().catch(() => null);
        screen.queue = { stats, items: enrichedItems, scheduler };
      } catch {
        // continue
      }
    }

    // Inbox focus when viewing /inbox — counts only (list-inbox has the rows).
    if (nav?.view === "inbox") {
      try {
        const { counts } = await buildInboxGroups(db);
        screen.inbox = counts;
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
