import { defineAction } from "@agent-native/core";
import { z } from "zod";

import {
  TRACKER_NAVIGATION_VIEWS,
  trackerRoutePath,
} from "../shared/navigation.js";
import { writeAppStateForCurrentTab } from "./_tab-state.js";

function writeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default defineAction({
  description:
    "Navigate the tracker UI. Views: board (the work-item board), projects, item (with itemId), sprints, sprint (with sprintId), queue, inbox (things awaiting a human decision), new-item, extensions, team.",
  schema: z.object({
    view: z
      .enum(TRACKER_NAVIGATION_VIEWS)
      .optional()
      .describe(
        "View: board, projects, item, sprints, sprint, queue, inbox, new-item, extensions, team",
      ),
    itemId: z.string().optional().describe("Work item to open (for view=item)"),
    projectId: z
      .string()
      .optional()
      .describe("Project to scope the board to (for view=board)"),
    sprintId: z
      .string()
      .optional()
      .describe("Sprint to open (for view=sprint)"),
  }),
  http: false,
  run: async (args) => {
    const { view, itemId, projectId, sprintId } = args;
    const resolvedView =
      view ?? (itemId ? "item" : sprintId ? "sprint" : undefined);
    if (!view && !itemId && !sprintId) {
      throw new Error("At least --view, --itemId, or --sprintId is required.");
    }
    if (resolvedView === "item" && !itemId) {
      throw new Error("item navigation requires an itemId.");
    }
    if (resolvedView === "sprint" && !sprintId) {
      throw new Error("sprint navigation requires a sprintId.");
    }

    const path = trackerRoutePath({
      view: resolvedView,
      itemId,
      projectId,
      sprintId,
    });
    if (!path)
      throw new Error(`Unsupported navigation target: ${resolvedView}.`);

    const nav: Record<string, string> = {};
    if (resolvedView) nav.view = resolvedView;
    if (itemId) nav.itemId = itemId;
    if (projectId) nav.projectId = projectId;
    if (sprintId) nav.sprintId = sprintId;
    nav.path = path;
    nav._writeId = writeId();

    await writeAppStateForCurrentTab("navigate", nav);
    return `Navigating to ${resolvedView || "item"}${itemId ? ` (item: ${itemId})` : ""}${sprintId ? ` (sprint: ${sprintId})` : ""} at ${path}`;
  },
});
