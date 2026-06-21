/**
 * list-routine-templates — list the built-in routine template library
 * (Phase A5 §1.5.15).
 *
 * Returns the metadata for each preset in `_routine-presets` so the Templates
 * page (and the agent) can show them and offer a one-click fork. This is a
 * static, owner-agnostic catalog — the presets are bundled constants, not the
 * user's own routines — so the action takes no input and returns the same list
 * for everyone. To materialize a template into your own routines, call
 * `fork-routine` with the chosen `id`.
 *
 * Usage:
 *   pnpm action list-routine-templates
 */

import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import {
  ROUTINE_PRESETS,
  toPresetSummary,
  type RoutinePresetSummary,
} from "./_routine-presets.js";

export default defineAction({
  description:
    "List the built-in routine templates the user can fork. Returns each template's id, name, description, category (schedule / event-cross-app / deterministic), trigger type, execution mode, and trigger details (cron, event, source app). Call this to show the template library, then fork one with fork-routine.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
    const templates: RoutinePresetSummary[] =
      ROUTINE_PRESETS.map(toPresetSummary);
    return { templates };
  },
});
