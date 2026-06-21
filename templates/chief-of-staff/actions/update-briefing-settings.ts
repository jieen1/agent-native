/**
 * Update the current user's briefing settings: which apps feed a briefing and
 * the per-app natural-language prompt overrides. User-scoped, additive merge.
 *
 * Reads the existing value, applies only the fields that were passed (so the UI
 * can patch `enabledApps` without clobbering `promptOverrides`, and vice versa),
 * and writes back through `@agent-native/core/settings`. Mirrors the mail
 * template's `update-mail-settings` pattern. Returns the normalized settings so
 * the caller (settings page or agent) sees the persisted result.
 *
 * Usage:
 *   pnpm action update-briefing-settings --enabledApps='["mail","calendar"]'
 *   pnpm action update-briefing-settings --promptOverrides='{"mail":"Only show VIP threads."}'
 */

import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server";
import { getUserSetting, putUserSetting } from "@agent-native/core/settings";
import { z } from "zod";
import {
  BRIEFING_SETTINGS_KEY,
  parseBriefingSettings,
  type BriefingSettings,
} from "../shared/briefing-settings.js";

const schema = z.object({
  enabledApps: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'App ids that should feed a briefing, e.g. ["mail","calendar","brain","analytics"]. Replaces the current set when provided.',
    ),
  promptOverrides: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Per-app natural-language prompt overrides as { appId: prompt }. Merged into the current overrides; pass an empty string for an app to clear its override.",
    ),
});

/** Apply a per-app override patch: set non-empty values, delete empty ones. */
function mergeOverrides(
  current: Record<string, string>,
  patch: Record<string, string>,
): Record<string, string> {
  const next = { ...current };
  for (const [appId, prompt] of Object.entries(patch)) {
    const id = appId.trim();
    if (!id) continue;
    const trimmed = prompt.trim();
    if (trimmed) next[id] = trimmed;
    else delete next[id];
  }
  return next;
}

export default defineAction({
  description:
    "Update the current user's briefing settings: enabledApps (which apps feed a briefing) and/or promptOverrides (per-app natural-language question overrides). Only the provided fields change; promptOverrides is merged (empty string clears an app's override).",
  schema,
  run: async (args): Promise<BriefingSettings> => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("no authenticated user");

    const current = parseBriefingSettings(
      await getUserSetting(ownerEmail, BRIEFING_SETTINGS_KEY),
    );

    const enabledApps =
      args.enabledApps !== undefined
        ? Array.from(
            new Set(args.enabledApps.map((a) => a.trim()).filter(Boolean)),
          )
        : current.enabledApps;

    const promptOverrides =
      args.promptOverrides !== undefined
        ? mergeOverrides(current.promptOverrides, args.promptOverrides)
        : current.promptOverrides;

    const next: BriefingSettings = { enabledApps, promptOverrides };
    await putUserSetting(ownerEmail, BRIEFING_SETTINGS_KEY, {
      enabledApps: next.enabledApps,
      promptOverrides: next.promptOverrides,
    });
    return next;
  },
});
