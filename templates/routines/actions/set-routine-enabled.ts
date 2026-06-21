/**
 * Toggle a routine's `enabled` flag.
 *
 * Reads the owner-scoped resource, flips `enabled` in the frontmatter, and
 * rewrites it through `buildTriggerContent` (preserving `triggerType` and all
 * other fields). When a routine is disabled, the engine's scheduler skips it on
 * tick. Owner-scoped, so another user's routine cannot be toggled.
 *
 * Usage:
 *   pnpm action set-routine-enabled --name=morning-briefing --enabled=false
 */

import { defineAction } from "@agent-native/core/action";
import {
  buildTriggerContent,
  parseTriggerFrontmatter,
  refreshEventSubscriptions,
} from "@agent-native/core/triggers";
import { resourcePut } from "@agent-native/core/resources/store";
import { z } from "zod";
import {
  getOwnerRoutineResource,
  requireOwnerEmail,
  routinePath,
  slugifyRoutineName,
  toRoutineSummary,
} from "./_routines-lib.js";

export default defineAction({
  description:
    "Enable or disable a routine by its slug name. Disabling a routine makes the scheduler skip it on tick; the file is preserved. Only the current user's routines can be toggled.",
  schema: z.object({
    name: z
      .string()
      .min(1)
      .describe("Routine slug name (the jobs/{name}.md file name)."),
    enabled: z.boolean().describe("New enabled state."),
  }),
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
    const nextMeta = {
      ...meta,
      enabled: args.enabled,
      // Force the scheduler to recompute nextRun from the cron after re-enable.
      nextRun: args.enabled ? undefined : meta.nextRun,
    };

    const content = buildTriggerContent(nextMeta, body);
    const saved = await resourcePut(owner, routinePath(name), content);

    // Enabling/disabling an event routine must (un)subscribe it immediately;
    // the dispatcher only subscribes enabled event routines. Safe for schedule
    // routines (no-op). A refresh failure must not mask the successful toggle.
    try {
      await refreshEventSubscriptions();
    } catch (err) {
      console.error(
        "[set-routine-enabled] refreshEventSubscriptions failed (toggle saved, subscriptions may lag until next restart):",
        err instanceof Error ? err.message : err,
      );
    }

    return {
      routine: toRoutineSummary(
        name,
        nextMeta,
        new Date(saved.updatedAt).toISOString(),
      ),
    };
  },
});
