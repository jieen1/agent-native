/**
 * Client-side `locale` cookie helpers. All access guards `window`/`document`
 * so the module is import-safe on the server (where it becomes a no-op).
 */

import { isLocale, type Locale } from "./runtime.js";

export const LOCALE_COOKIE = "locale";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** Read the persisted locale from the browser cookie, if present and valid. */
export function readLocaleCookie(): Locale | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${LOCALE_COOKIE}=([^;]*)`),
  );
  if (!match) return null;
  const value = decodeURIComponent(match[1]);
  return isLocale(value) ? value : null;
}

/** Persist the locale to a client cookie (1 year, path `/`). No-op on server. */
export function writeLocaleCookie(locale: Locale): void {
  if (typeof document === "undefined") return;
  document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(
    locale,
  )}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
}
