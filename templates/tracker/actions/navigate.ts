import { defineAction } from "@agent-native/core";
import { z } from "zod";
import { writeAppStateForCurrentTab } from "./_tab-state.js";
import {
  TRACKER_NAVIGATION_VIEWS,
  trackerRoutePath,
} from "../shared/navigation.js";

function writeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default defineAction({
  description:
    "Navigate the tracker UI. Views: board (the work-item board), projects, item (with itemId), extensions, team.",
  schema: z.object({
    view: z
      .enum(TRACKER_NAVIGATION_VIEWS)
      .optional()
      .describe("View: board, projects, item, extensions, team"),
    itemId: z.string().optional().describe("Work item to open (for view=item)"),
    projectId: z
      .string()
      .optional()
      .describe("Project to scope the board to (for view=board)"),
  }),
  http: false,
  run: async (args) => {
    const { view, itemId, projectId } = args;
    const resolvedView = view ?? (itemId ? "item" : undefined);
    if (!view && !itemId) {
      throw new Error("At least --view or --itemId is required.");
    }
    if (resolvedView === "item" && !itemId) {
      throw new Error("item navigation requires an itemId.");
    }

    const path = trackerRoutePath({ view: resolvedView, itemId, projectId });
    if (!path) throw new Error(`Unsupported navigation target: ${resolvedView}.`);

    const nav: Record<string, string> = {};
    if (resolvedView) nav.view = resolvedView;
    if (itemId) nav.itemId = itemId;
    if (projectId) nav.projectId = projectId;
    nav.path = path;
    nav._writeId = writeId();

    await writeAppStateForCurrentTab("navigate", nav);
    return `Navigating to ${resolvedView || "item"}${itemId ? ` (item: ${itemId})` : ""} at ${path}`;
  },
});
