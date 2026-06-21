/**
 * Get a single routine by name (frontmatter summary + raw instructions body).
 *
 * Owner-scoped: only returns the routine if it belongs to the requesting user,
 * which is also how another user's routine is hidden (it is simply not found).
 *
 * Usage:
 *   pnpm action get-routine --name=morning-briefing
 */

import { defineAction } from "@agent-native/core/action";
import { parseTriggerFrontmatter } from "@agent-native/core/triggers";
import { z } from "zod";
import {
  getOwnerRoutineResource,
  requireOwnerEmail,
  slugifyRoutineName,
  toRoutineSummary,
} from "./_routines-lib.js";

export default defineAction({
  description:
    "Get a single routine by its slug name. Returns the routine summary (cron, enabled, human-readable schedule, last/next run) plus its instructions body. Returns notFound when the routine does not exist for the current user.",
  schema: z.object({
    name: z
      .string()
      .min(1)
      .describe("Routine slug name (the jobs/{name}.md file name)."),
  }),
  http: { method: "GET" },
  run: async (args) => {
    const owner = requireOwnerEmail();
    const name = slugifyRoutineName(args.name);
    if (!name) {
      throw new Error(`Invalid routine name: "${args.name}".`);
    }

    const resource = await getOwnerRoutineResource(owner, name);
    if (!resource) {
      return { notFound: true, name };
    }

    const { meta, body } = parseTriggerFrontmatter(resource.content);
    return {
      routine: toRoutineSummary(
        name,
        meta,
        new Date(resource.updatedAt).toISOString(),
      ),
      instructions: body,
    };
  },
});
