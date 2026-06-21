/**
 * Polls `application_state.locale` and applies the server-side locale on the
 * client. Mirrors the pattern in `packages/core/src/client/appearance.ts`
 * (`useAppearanceSync`): a 4s react-query poll surfaces the server write into
 * the runtime store, the `locale` cookie, localStorage, and
 * `document.documentElement.lang`.
 *
 * The agent's `change-language` action writes `application_state.locale`
 * server-side; this hook is how that write reaches the running UI.
 */

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentNativePath } from "@agent-native/core/client";
import { getLocale, setLocale, isLocale, type Locale } from "./runtime.js";
import { writeLocaleCookie } from "./cookie.js";

const STORAGE_KEY = "locale";

function persistLocale(locale: Locale): void {
  writeLocaleCookie(locale);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // localStorage unavailable
    }
  }
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
  }
}

interface UseLocaleSyncOptions {
  /**
   * When false, the poll is disabled and no server locale is applied. The
   * I18nProvider passes `false` during a pseudo-locale (`zz`) sweep so the
   * application-state locale never overwrites the pseudo-locale. Defaults true.
   */
  enabled?: boolean;
}

export function useLocaleSync(options: UseLocaleSyncOptions = {}): void {
  const enabled = options.enabled ?? true;
  const { data } = useQuery({
    queryKey: ["agent-native", "locale"],
    queryFn: async () => {
      const res = await fetch(
        agentNativePath("/_agent-native/application-state/locale"),
        { credentials: "include" },
      );
      if (!res.ok) return null;
      return (await res.json()) as { locale?: string } | null;
    },
    enabled,
    refetchInterval: 4_000,
    staleTime: 2_000,
  });

  const serverLocale = data?.locale;
  useEffect(() => {
    if (!isLocale(serverLocale)) return;
    if (getLocale() !== serverLocale) {
      setLocale(serverLocale);
      persistLocale(serverLocale);
    }
  }, [serverLocale]);
}
