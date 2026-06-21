/**
 * Per-user briefing settings: which apps feed a briefing, and per-app
 * natural-language prompt overrides (docs/CHIEF_OF_STAFF_DESIGN.md §7 /
 * docs/IMPLEMENTATION_PLAN.md Phase B3).
 *
 * Stored via `@agent-native/core/settings` `getUserSetting`/`putUserSetting`
 * under one key — the same pattern the mail template uses for `mail-settings`
 * (`templates/mail/actions/update-mail-settings.ts`). This is a durable user
 * preference, not navigation/selection state, so it belongs in user settings,
 * not `application_state`; and reusing the settings store keeps the schema
 * additive (no new table).
 *
 * The settings store returns `Record<string, unknown> | null`, so the parse
 * helper here narrows it defensively and merges in defaults. Pure (apart from
 * the DEFAULT_APPS import) so it unit-tests directly.
 */

import { DEFAULT_APPS } from "./app-prompts.js";

/** Settings key, prefixed per-user to `u:<email>:chief-of-staff-briefing-settings`. */
export const BRIEFING_SETTINGS_KEY = "chief-of-staff-briefing-settings";

/** Normalized, always-populated briefing settings used by the action layer. */
export interface BriefingSettings {
  /** App ids that feed a briefing when the caller passes no explicit `apps`. */
  enabledApps: string[];
  /** appId -> overriding natural-language question for that app's fan-out leg. */
  promptOverrides: Record<string, string>;
}

/** A clean string array (trimmed, de-duped, non-empty) or undefined. */
function cleanStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** A clean { appId: prompt } record, dropping empty/non-string entries. */
function cleanPromptOverrides(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [appId, prompt] of Object.entries(value)) {
    const id = appId.trim();
    if (!id || typeof prompt !== "string") continue;
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) continue;
    out[id] = trimmedPrompt;
  }
  return out;
}

/**
 * Normalize a raw settings record (or null) into fully-populated
 * `BriefingSettings`. Missing/invalid `enabledApps` falls back to the default
 * four-source set; missing/invalid `promptOverrides` falls back to `{}`.
 */
export function parseBriefingSettings(
  raw: Record<string, unknown> | null | undefined,
): BriefingSettings {
  const enabledApps = cleanStringArray(raw?.enabledApps);
  return {
    enabledApps:
      enabledApps && enabledApps.length > 0 ? enabledApps : [...DEFAULT_APPS],
    promptOverrides: cleanPromptOverrides(raw?.promptOverrides),
  };
}
