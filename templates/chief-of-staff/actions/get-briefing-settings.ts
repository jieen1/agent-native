/**
 * Read the current user's briefing settings (which apps feed a briefing + the
 * per-app prompt overrides). Read-only, user-scoped.
 *
 * Backs the settings page (`app/routes/settings.tsx`) via `useActionQuery` and
 * is also the source of truth `compile-briefing` consults for the default app
 * set and prompt overrides. Returns fully-populated settings — never null —
 * with the default four-source set when the user has not customized anything.
 *
 * Usage:
 *   pnpm action get-briefing-settings
 */

import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server";
import { getUserSetting } from "@agent-native/core/settings";
import { z } from "zod";
import { DEFAULT_APPS } from "../shared/app-prompts.js";
import {
  BRIEFING_SETTINGS_KEY,
  parseBriefingSettings,
  type BriefingSettings,
} from "../shared/briefing-settings.js";

export interface BriefingSettingsResult extends BriefingSettings {
  /** The full default app set, so the UI can offer toggles for every source. */
  availableApps: string[];
}

export default defineAction({
  description:
    "Read the current user's briefing settings: which apps feed a briefing (enabledApps) and per-app natural-language prompt overrides (promptOverrides). Returns the default four-source set when nothing is customized, plus availableApps for the settings UI.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async (): Promise<BriefingSettingsResult> => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("no authenticated user");

    const raw = await getUserSetting(ownerEmail, BRIEFING_SETTINGS_KEY);
    const settings = parseBriefingSettings(raw);
    return { ...settings, availableApps: [...DEFAULT_APPS] };
  },
});
