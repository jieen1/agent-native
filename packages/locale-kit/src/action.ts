/**
 * `change-language` agent action factory.
 *
 * Mirrors the framework's built-in `change-appearance` action
 * (`packages/core/src/appearance/actions/change-appearance.ts`): it writes the
 * chosen value to `application_state` via the same `writeAppState(key, value)`
 * script helper. `writeAppState` resolves the caller's session id from the
 * per-request context (or `AGENT_USER_EMAIL` for CLI), then calls
 * `appStatePut(sessionId, "locale", { locale }, { requestSource: "agent" })`.
 * The client `useLocaleSync()` poll surfaces that write into the running UI —
 * the exact same session-scoped mechanism `useAppearanceSync()` relies on.
 *
 * In addition to the session-level write, this action persists a durable,
 * cross-device preference under `u:<email>:locale` when an authenticated user
 * email is available in the request context (via `putUserSetting`), matching
 * the plan's three-tier locale model (session app-state + durable user setting;
 * the SSR cookie is written client-side by `useLocaleSync`).
 */

import { z } from "zod";
import { defineAction } from "@agent-native/core/action";
import { writeAppState } from "@agent-native/core/application-state";
import { putUserSetting } from "@agent-native/core/settings";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { registerCatalog, setLocale, t, tx, type Locale } from "./runtime.js";
import { setServerLocaleForEmail } from "./server-locale.js";
import enJson from "./catalogs/en.json";
import zhJson from "./catalogs/zh.json";

const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  "zh-CN": "Simplified Chinese",
};

// Register catalogs at module load so server-side `t()`/`tx()` resolve the
// localized confirmation message even though the React I18nProvider (which also
// registers them) never runs in the server/action environment.
registerCatalog("en", enJson as Record<string, string>);
registerCatalog("zh-CN", zhJson as Record<string, string>);

export function createChangeLanguageAction() {
  return defineAction({
    description:
      "Set the user interface language. Use when the user asks to switch the app to English or Chinese (e.g. 'switch to Chinese', '切换成中文', 'use English'). Pass 'zh-CN' for Simplified Chinese or 'en' for English.",
    schema: z.object({
      locale: z
        .enum(["en", "zh-CN"])
        .describe(
          "Target interface locale. One of: en (English), zh-CN (Simplified Chinese).",
        ),
    }),
    run: async ({ locale }) => {
      // Session-level: same mechanism as change-appearance.
      await writeAppState("locale", { locale });

      // Durable cross-device preference, when we know who is asking.
      const email = getRequestUserEmail();
      if (email) {
        await putUserSetting(email, "locale", { locale });
        // Record the per-user server locale so subsequent server-side action
        // messages in THIS process (same or later requests for this user)
        // resolve in the freshly chosen locale, not the module-global.
        setServerLocaleForEmail(email, locale);
      }

      // Resolve confirmation text in the freshly selected locale.
      setLocale(locale);
      const language = t(LOCALE_LABELS[locale]);
      return {
        locale,
        message: tx("Switched the interface language to {language}.", {
          language,
        }),
      };
    },
  });
}

/**
 * Pre-built `change-language` action as the module DEFAULT export.
 *
 * Templates re-export this default from their `actions/change-language.ts`
 * (`export { default } from "locale-kit/action";`). The framework's action
 * registry generator (`scanActionFiles` in
 * `@agent-native/core/vite/action-types-plugin`) only includes an
 * `actions/<name>.ts` file when its source either calls `defineAction` OR
 * matches the `export { default } from "..."` re-export pattern; a bare
 * `export default createChangeLanguageAction();` matched neither, so
 * `change-language` was silently dropped from every template registry and its
 * HTTP/agent route fell back to a failing CLI subprocess. Providing a default
 * export here lets templates use the recognized re-export form while still
 * dispatching in-process. The action is keyed by FILENAME
 * (`change-language.ts` -> `"change-language"`), so no name field is needed.
 *
 * The named `createChangeLanguageAction` export is kept for back-compat.
 */
const changeLanguageAction = createChangeLanguageAction();
export default changeLanguageAction;
