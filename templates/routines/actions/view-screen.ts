/**
 * See what the user is currently looking at on screen.
 *
 * Returns a structured snapshot so the agent can reason about the live UI:
 *   {
 *     screen: <navigation.screen | "chat">,
 *     navigation: <raw application_state navigation object>,
 *     routines: <the current user's schedule-kind routines>,
 *     editingRoutineName?: <slug of the routine being edited, if any>,
 *   }
 *
 * This lets the agent answer "what routines do I have" and "which one am I
 * editing right now" directly from structured state (not from prose).
 *
 * Usage:
 *   pnpm action view-screen
 */

import { defineAction } from "@agent-native/core/action";
import { readAppState } from "@agent-native/core/application-state";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { z } from "zod";
import { listOwnerRoutines, type RoutineSummary } from "./_routines-lib.js";

/** Pull a routine slug out of the navigation state, if present. */
function editingRoutineName(
  navigation: Record<string, unknown> | null,
): string | undefined {
  if (!navigation) return undefined;
  const candidate =
    navigation.routineName ?? navigation.name ?? navigation.editingRoutineName;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}

export default defineAction({
  description:
    "See what the user is currently looking at in Routines. Returns the current screen, the raw navigation state, the user's routines (both schedule and event kinds), and which routine (if any) is being edited. Always call this first before acting on the visible context.",
  schema: z.object({}),
  http: false,
  readOnly: true,
  run: async () => {
    const navigation = (await readAppState("navigation")) as Record<
      string,
      unknown
    > | null;

    const screen =
      navigation && typeof navigation.screen === "string"
        ? navigation.screen
        : "chat";

    let routines: RoutineSummary[] = [];
    const owner = getRequestUserEmail();
    if (owner) {
      try {
        routines = await listOwnerRoutines(owner);
      } catch {
        // No authenticated DB context / empty state — degrade to empty list.
        routines = [];
      }
    }

    return {
      screen,
      navigation: navigation ?? null,
      routines,
      editingRoutineName: editingRoutineName(navigation),
    };
  },
});
