/**
 * Navigate the UI to a view.
 *
 * Writes a navigate command to application state which the UI reads and auto-deletes.
 *
 * Usage:
 *   pnpm action navigate --view=chat
 *   pnpm action navigate --path=/some/route
 *   pnpm action navigate --briefingId=brief_abc123
 *
 * Options:
 *   --view        View name to navigate to
 *   --path        URL path to navigate to
 *   --briefingId  Open a specific briefing's detail page
 */

import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { writeAppState } from "@agent-native/core/application-state";

export default defineAction({
  description:
    "Navigate the UI to a specific view, path, or briefing. Pass briefingId to take the user to a specific briefing's detail page. Writes a navigate command to application state which the UI reads and auto-deletes.",
  schema: z.object({
    view: z.string().optional().describe("View name to navigate to"),
    path: z.string().optional().describe("URL path to navigate to"),
    briefingId: z
      .string()
      .optional()
      .describe("Open a specific briefing's detail page by id"),
  }),
  http: false,
  run: async (args) => {
    // briefingId is a convenience that resolves to the briefing detail path.
    const path = args.briefingId ? `/briefings/${args.briefingId}` : args.path;

    if (!args.view && !path) {
      throw new Error("At least --view, --path, or --briefingId is required.");
    }
    const nav: Record<string, string> = {};
    if (args.view) nav.view = args.view;
    if (path) nav.path = path;
    nav._writeId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await writeAppState("navigate", nav);
    return `Navigating to ${args.view || path}`;
  },
});
