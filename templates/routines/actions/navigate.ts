/**
 * Navigate the UI to a Routines view.
 *
 * Writes a navigate command to application state which the UI reads and
 * auto-deletes. Supports the high-level Routines screens directly, so the agent
 * can say "take me to that routine" without hand-computing a URL:
 *
 *   view=routines                       -> /routines
 *   view=routine-edit  routineName=foo  -> /routines/foo
 *   view=runs          routineName=foo  -> /routines/foo/runs
 *   view=keys                           -> /routines/keys
 *   view=chat                           -> /
 *
 * A raw `path` may still be supplied for anything not covered by `view`. Every
 * command carries a `_writeId` so the UI can de-duplicate replays.
 *
 * Usage:
 *   pnpm action navigate --view=routines
 *   pnpm action navigate --view=routine-edit --routineName=morning-briefing
 *   pnpm action navigate --path=/routines
 */

import { defineAction } from "@agent-native/core/action";
import { writeAppState } from "@agent-native/core/application-state";
import { z } from "zod";
import { slugifyRoutineName } from "./_routines-lib.js";

type RoutineView = "chat" | "routines" | "routine-edit" | "runs" | "keys";

/** Map a high-level view (+ optional routine slug) to a canonical URL path. */
function pathForView(view: RoutineView, routineName?: string): string {
  switch (view) {
    case "routines":
      return "/routines";
    case "routine-edit":
      return routineName ? `/routines/${routineName}` : "/routines";
    case "runs":
      return routineName ? `/routines/${routineName}/runs` : "/routines";
    case "keys":
      return "/routines/keys";
    case "chat":
    default:
      return "/";
  }
}

export default defineAction({
  description:
    "Navigate the Routines UI. Use `view` for known screens (routines list, routine-edit, runs, keys, chat) with an optional `routineName`, or `path` for a raw URL. Writes a navigate command to application state which the UI consumes and auto-deletes.",
  schema: z.object({
    view: z
      .enum(["chat", "routines", "routine-edit", "runs", "keys"])
      .optional()
      .describe("High-level Routines screen to open."),
    routineName: z
      .string()
      .optional()
      .describe("Routine slug name, for routine-edit / runs views."),
    path: z
      .string()
      .optional()
      .describe("Raw URL path to navigate to (overrides view-derived path)."),
  }),
  http: false,
  run: async (args) => {
    if (!args.view && !args.path) {
      throw new Error("At least --view or --path is required.");
    }

    const routineName = args.routineName
      ? slugifyRoutineName(args.routineName)
      : undefined;

    const path =
      args.path ??
      pathForView((args.view ?? "chat") as RoutineView, routineName);

    const nav: Record<string, string> = { path };
    if (args.view) nav.view = args.view;
    if (routineName) nav.routineName = routineName;
    nav._writeId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    await writeAppState("navigate", nav);
    return { navigating: true, path, view: args.view, routineName };
  },
});
