/**
 * Framework-free runtime i18n store.
 *
 * Holds the current locale, per-locale catalogs, and a listener set. The
 * English source string IS the key — a missing translation falls back to the
 * key itself, so wrapping a string in `t()` never breaks the UI.
 *
 * This module is safe to import on the server: the only React dependency is
 * `useLocale`, which uses `useSyncExternalStore` and guards against the absence
 * of `window` via the server snapshot.
 *
 * All shared mutable state (current locale, catalogs, listeners) lives on the
 * process-wide singleton in `state.ts` so that this module and
 * `server-locale.ts` — reachable through different package entry points — never
 * desync into separate copies under bundling.
 */

import { useSyncExternalStore } from "react";
import { resolveActiveLocale } from "./server-locale.js";
import { getLocaleKitState } from "./state.js";

export type Locale = "en" | "zh-CN";

/**
 * The built-in pseudo-locale. It is NOT part of the {@link Locale} union (so it
 * never leaks into normal typed paths: catalogs, cookies, `change-language`),
 * but it IS a valid ACTIVE locale at the `setLocale` boundary. When active, the
 * runtime does not look up any catalog — every `t()` / `tx()` result is wrapped
 * in the `⟦ … ⟧` markers below. A render sweep can then flag any visible text
 * that lacks the markers as text NOT going through `t()` — i.e. an i18n miss.
 */
export const PSEUDO_LOCALE = "zz" as const;
export type PseudoLocale = typeof PSEUDO_LOCALE;

/**
 * Markers wrapped around every pseudo-locale string. Distinct, rare Unicode
 * brackets so a DOM/text scan can detect their ABSENCE without false matches
 * against ordinary ASCII content.
 */
export const PSEUDO_PREFIX = "⟦"; // ⟦
export const PSEUDO_SUFFIX = "⟧"; // ⟧

/** An active locale: a real {@link Locale} OR the built-in pseudo-locale. */
export type ActiveLocale = Locale | PseudoLocale;

const LOCALES: ReadonlySet<string> = new Set<Locale>(["en", "zh-CN"]);

/** Type guard: is the given value one of the supported (real) locales. */
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && LOCALES.has(value);
}

/** Type guard: is the given value the built-in pseudo-locale. */
export function isPseudoLocale(value: unknown): value is PseudoLocale {
  return value === PSEUDO_LOCALE;
}

/** Type guard: is the given value any active locale (real OR pseudo). */
export function isActiveLocale(value: unknown): value is ActiveLocale {
  return isLocale(value) || isPseudoLocale(value);
}

/** Wrap a rendered string in the pseudo-locale markers. */
function pseudoWrap(value: string): string {
  return `${PSEUDO_PREFIX}${value}${PSEUDO_SUFFIX}`;
}

/**
 * Detect whether the pseudo-locale should be activated for this render, from a
 * browser signal that needs no app wiring:
 *
 *   1. `?locale=zz` (or `?pseudo=1`) in the page URL, or
 *   2. `localStorage["locale"] === "zz"` (so it survives navigation), or
 *   3. `window.__LOCALE_KIT_PSEUDO__ === true` (an explicit programmatic flag a
 *      Playwright sweep can set before the app boots).
 *
 * Returns false on the server and whenever none of the signals are present, so
 * normal runs are completely unaffected. The {@link I18nProvider} calls this to
 * decide its initial locale; activating mid-session is also possible via
 * `setLocale("zz")`.
 */
export function isPseudoLocaleRequested(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if ((window as { __LOCALE_KIT_PSEUDO__?: unknown }).__LOCALE_KIT_PSEUDO__) {
      return true;
    }
    const params = new URLSearchParams(window.location.search);
    if (params.get("locale") === PSEUDO_LOCALE) return true;
    if (params.get("pseudo") === "1") return true;
    if (window.localStorage?.getItem("locale") === PSEUDO_LOCALE) return true;
  } catch {
    // Inaccessible location/localStorage (sandboxed iframe) — not requested.
  }
  return false;
}

function notify(): void {
  for (const listener of getLocaleKitState().listeners) {
    listener();
  }
}

/** Merge a batch of entries into a locale's catalog (additive). */
export function registerCatalog(
  locale: Locale,
  entries: Record<string, string>,
): void {
  const state = getLocaleKitState();
  state.catalogs[locale] = { ...state.catalogs[locale], ...entries };
  // Newly registered strings can change rendered output; notify subscribers.
  notify();
}

/**
 * Read the current active locale. Narrowed to {@link Locale} for callers that
 * only handle real locales; when the pseudo-locale is active this still returns
 * its raw value (`"zz"`), so prefer {@link getActiveLocale} where the pseudo
 * case matters.
 */
export function getLocale(): Locale {
  return getLocaleKitState().currentLocale as Locale;
}

/** Read the current active locale, including the pseudo-locale. */
export function getActiveLocale(): ActiveLocale {
  return getLocaleKitState().currentLocale;
}

/**
 * Switch the active locale and notify all subscribers. No-op if unchanged.
 *
 * Accepts a WIDER `ActiveLocale | string` at the boundary so callers (and the
 * pseudo-locale render sweep) can activate `"zz"` without it leaking into the
 * typed {@link Locale} union elsewhere. Any value that is neither a real locale
 * nor the pseudo-locale is rejected.
 */
export function setLocale(locale: ActiveLocale | string): void {
  const state = getLocaleKitState();
  if (!isActiveLocale(locale) || locale === state.currentLocale) return;
  state.currentLocale = locale;
  notify();
}

/** Subscribe to locale/catalog changes. Returns an unsubscribe function. */
export function subscribe(callback: () => void): () => void {
  const { listeners } = getLocaleKitState();
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/**
 * Translate an English-source key for the ACTIVE locale. On the server the
 * active locale is resolved per request (the requesting user's locale); on the
 * client it is the module-global. Falls back to the key itself when no
 * translation exists, so wrapping a string in `t()` never breaks the UI.
 */
export function t(key: string): string {
  const state = getLocaleKitState();
  if (isPseudoLocale(state.currentLocale)) return pseudoWrap(key);
  const locale = resolveActiveLocale(state.currentLocale);
  return state.catalogs[locale]?.[key] ?? key;
}

/**
 * Translate with interpolation. Looks up like `t()`, then replaces `{name}`
 * placeholders with the matching value from `vars`. Unmatched placeholders are
 * left untouched.
 */
export function tx(key: string, vars: Record<string, string | number>): string {
  const state = getLocaleKitState();
  // Pseudo-locale: interpolate against the raw key, THEN wrap the whole result
  // so the markers sit around the interpolated output (not inside, where the
  // placeholders are). This keeps a single ⟦…⟧ pair per visible string.
  const template = isPseudoLocale(state.currentLocale) ? key : t(key);
  const interpolated = template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
  return isPseudoLocale(state.currentLocale)
    ? pseudoWrap(interpolated)
    : interpolated;
}

/**
 * React hook returning the current locale and re-rendering on change. Uses a
 * stable server snapshot of `"zh-CN"` (this deployment's default) so SSR and the
 * first client paint agree for users without a saved locale cookie.
 */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, () => "zh-CN");
}
