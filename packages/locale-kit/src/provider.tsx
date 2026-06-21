/**
 * I18nProvider — registers the seed catalogs, sets the initial locale, keeps
 * the running UI in sync with server-side locale writes, and reflects the
 * active locale onto `<html lang>`.
 */

import { Fragment, useEffect, useState, type ReactNode } from "react";
import {
  isPseudoLocaleRequested,
  PSEUDO_LOCALE,
  registerCatalog,
  setLocale,
  useLocale,
  type Locale,
} from "./runtime.js";
import { readLocaleCookie } from "./cookie.js";
import { useLocaleSync } from "./sync.js";
import enJson from "./catalogs/en.json";
import zhJson from "./catalogs/zh.json";

interface I18nProviderProps {
  /** Server-resolved initial locale (e.g. from the request cookie). */
  initialLocale?: Locale;
  children: ReactNode;
}

let catalogsRegistered = false;

function ensureCatalogsRegistered(): void {
  if (catalogsRegistered) return;
  catalogsRegistered = true;
  registerCatalog("en", enJson as Record<string, string>);
  registerCatalog("zh-CN", zhJson as Record<string, string>);
}

export function I18nProvider({ initialLocale, children }: I18nProviderProps) {
  // Register catalogs + set the initial locale exactly once, before first
  // paint, so `t()` resolves correctly during the initial render.
  // When a pseudo-locale sweep is requested (e.g. `?locale=zz`), activating it
  // takes precedence over the cookie/server locale so the completeness audit
  // can see EVERY rendered string wrapped in ⟦…⟧ markers.
  const pseudoRequested = useState(() => isPseudoLocaleRequested())[0];

  useState(() => {
    ensureCatalogsRegistered();
    setLocale(
      pseudoRequested
        ? PSEUDO_LOCALE
        : (initialLocale ?? readLocaleCookie() ?? "en"),
    );
    return null;
  });

  // During a pseudo sweep, do NOT let the application-state poll overwrite the
  // pseudo-locale with the real server locale.
  useLocaleSync({ enabled: !pseudoRequested });

  const locale = useLocale();

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  // Tradeoff: `t()` reads the locale from a module-level store, so plain text
  // wrapped in `t()` does not re-render on its own when the locale flips.
  // Keying a Fragment on the locale remounts the subtree on every switch,
  // guaranteeing every string re-resolves. Language switches are rare
  // (a deliberate user/agent action), so the remount cost is acceptable.
  return <Fragment key={locale}>{children}</Fragment>;
}
