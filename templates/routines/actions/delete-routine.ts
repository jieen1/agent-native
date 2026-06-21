/**
 * Delete a routine by name.
 *
 * Owner-scoped: resolves the resource only within the requesting user's owner
 * scope, so another user's routine cannot be deleted (it is not found). Deletes
 * by the resolved resource id.
 *
 * Usage:
 *   pnpm action delete-routine --name=morning-briefing
 */

import { defineAction } from "@agent-native/core/action";
import { refreshEventSubscriptions } from "@agent-native/core/triggers";
import { resourceDelete } from "@agent-native/core/resources/store";
import { z } from "zod";
import {
  getOwnerRoutineResource,
  requireOwnerEmail,
  slugifyRoutineName,
} from "./_routines-lib.js";

export default defineAction({
  description:
    "Delete a routine by its slug name. Only the current user's routines can be deleted. Returns deleted:false when no matching routine exists.",
  schema: z.object({
    name: z
      .string()
      .min(1)
      .describe("Routine slug name (the jobs/{name}.md file name)."),
  }),
  http: { method: "DELETE" },
  run: async (args) => {
    const owner = requireOwnerEmail();
    const name = slugifyRoutineName(args.name);
    if (!name) {
      throw new Error(`Invalid routine name: "${args.name}".`);
    }

    const resource = await getOwnerRoutineResource(owner, name);
    if (!resource) {
      return { deleted: false, name };
    }

    const deleted = await resourceDelete(resource.id);

    // Tear down any bus subscription this routine kept alive. Safe for schedule
    // routines too (no-op). A refresh failure must not mask a successful delete.
    if (deleted) {
      try {
        await refreshEventSubscriptions();
      } catch (err) {
        console.error(
          "[delete-routine] refreshEventSubscriptions failed (routine deleted, a stale subscription may persist until next restart):",
          err instanceof Error ? err.message : err,
        );
      }
    }

    return { deleted, name };
  },
});
