/**
 * List the current user's routines (schedule + event kinds).
 *
 * Reads `resourceListAllOwners("jobs/")`, filters to the requesting owner, and
 * returns a UI/agent-friendly summary for each: name, kind, cron/event,
 * enabled, human-readable `describeCron` (schedule) or condition (event),
 * last-run status/time, and next run time (schedule only). Pass `kind` to
 * narrow to one kind.
 *
 * Usage:
 *   pnpm action list-routines
 *   pnpm action list-routines --kind=event
 */

import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { listOwnerRoutines, requireOwnerEmail } from "./_routines-lib.js";

export default defineAction({
  description:
    "List the current user's routines — both scheduled (cron) and event-triggered. Returns each routine's name, kind, cron schedule or subscribed event, a human-readable description, enabled state, last-run status/time, and next run time (for scheduled routines). Optionally filter by kind. Use this to answer 'what routines do I have'.",
  schema: z.object({
    kind: z
      .enum(["schedule", "event"])
      .optional()
      .describe("Narrow the list to one kind. Omit to list all routines."),
  }),
  http: { method: "GET" },
  run: async (args) => {
    const owner = requireOwnerEmail();
    const routines = await listOwnerRoutines(owner, { kind: args.kind });
    return { routines };
  },
});
