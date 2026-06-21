/**
 * fork-routine — copy a built-in template routine into the current user's owner
 * scope (Phase A5 §1.5.15).
 *
 * A fork is "read the bundled preset → write an owner row":
 *   1. Look up the preset by id from the in-bundle library (`_routine-presets`).
 *      Presets are NOT routine files on disk — the engine never seeds from disk,
 *      so the only way a preset becomes a live routine is to materialize it into
 *      the owner's SQL row here.
 *   2. Resolve a free slug (`uniqueRoutineName`): the base slug, with `-2`/`-3`/…
 *      appended on a same-name collision (§1.5.15). Owner-scoped, so two users
 *      can each fork to the same bare name.
 *   3. Serialize the preset frontmatter + body through the engine's own
 *      `buildTriggerContent` — the SAME serializer `save-routine` uses — so a
 *      forked routine round-trips identically (single serializer, §1.5.8).
 *   4. `resourcePut(owner, jobs/{name}.md, content)` writes the new row, owned by
 *      the current user. It is then a normal routine: independently editable,
 *      enable/disable-able, and deletable through the existing CRUD actions, and
 *      invisible to other users (owner-scope isolation).
 *   5. For an event preset, `refreshEventSubscriptions()` so the new subscription
 *      takes effect immediately (best-effort; a refresh failure never masks the
 *      successful save — same contract as save-routine).
 *
 * Usage:
 *   pnpm action fork-routine --presetId=daily-briefing
 *   pnpm action fork-routine --presetId=pr-recap-on-plan --name="My PR recap"
 */

import { defineAction } from "@agent-native/core/action";
import {
  buildTriggerContent,
  refreshEventSubscriptions,
  type TriggerFrontmatter,
} from "@agent-native/core/triggers";
import { resourcePut } from "@agent-native/core/resources/store";
import { getRequestOrgId } from "@agent-native/core/server/request-context";
import { z } from "zod";
import {
  requireOwnerEmail,
  routinePath,
  slugifyRoutineName,
  toRoutineSummary,
  uniqueRoutineName,
} from "./_routines-lib.js";
import { findRoutinePreset } from "./_routine-presets.js";

export default defineAction({
  description:
    "Fork a built-in template routine into your own routines. Copies the chosen preset (by `presetId` from list-routine-templates) into a new routine you own, which you can then edit, enable/disable, or delete independently. Pass an optional `name` to override the slug; on a name collision a numeric suffix (-2, -3, …) is appended. Returns the created routine summary.",
  schema: z.object({
    presetId: z
      .string()
      .min(1)
      .describe(
        "Id of the template routine to fork (from list-routine-templates).",
      ),
    name: z
      .string()
      .optional()
      .describe(
        "Optional name for the forked routine. Slugged to [a-z0-9-]; defaults to the preset's id. A numeric suffix is appended on collision.",
      ),
  }),
  run: async (args) => {
    const owner = requireOwnerEmail();
    const orgId = getRequestOrgId() ?? undefined;

    const preset = findRoutinePreset(args.presetId);
    if (!preset) {
      throw new Error(
        `No routine template with id "${args.presetId}". Use list-routine-templates to see available templates.`,
      );
    }

    // Resolve the slug. Prefer an explicit name, else the preset id; fall back to
    // the display name only if neither slugs to something usable.
    const base =
      slugifyRoutineName(args.name ?? "") ||
      slugifyRoutineName(preset.id) ||
      slugifyRoutineName(preset.displayName);
    if (!base) {
      throw new Error(
        "Could not derive a valid routine name for this template.",
      );
    }
    const name = await uniqueRoutineName(owner, base);

    // Serialize through the engine's own serializer so the forked file is
    // byte-compatible with a save-routine write (round-trips through
    // parseTriggerFrontmatter). Owner/org/enabled are filled here; run-state
    // fields start unset.
    const meta: TriggerFrontmatter = {
      schedule: preset.frontmatter.schedule ?? "",
      enabled: true,
      triggerType: preset.triggerType,
      event: preset.frontmatter.event,
      sourceApp: preset.frontmatter.sourceApp,
      condition: preset.frontmatter.condition,
      mode: preset.mode,
      domain: preset.frontmatter.domain,
      createdBy: owner,
      orgId,
    };

    const content = buildTriggerContent(meta, preset.body);
    const saved = await resourcePut(owner, routinePath(name), content);

    // Event routines subscribe immediately; safe to call for schedule forks too
    // (a no-op when no event routine changed). A refresh failure must never mask
    // the successful fork — same contract as save-routine.
    if (preset.triggerType === "event") {
      try {
        await refreshEventSubscriptions();
      } catch (err) {
        console.error(
          "[fork-routine] refreshEventSubscriptions failed (routine forked, subscription may lag until next restart):",
          err instanceof Error ? err.message : err,
        );
      }
    }

    return {
      forked: true,
      presetId: preset.id,
      routine: toRoutineSummary(
        name,
        meta,
        new Date(saved.updatedAt).toISOString(),
      ),
    };
  },
});
