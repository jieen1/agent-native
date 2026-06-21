/**
 * locale-kit — runtime i18n foundation for Agent-Native templates.
 *
 * Barrel for the framework-facing surface. Server-only helpers live in
 * `locale-kit/action`; formatting helpers live in `locale-kit/format`.
 */

export {
  t,
  tx,
  useLocale,
  setLocale,
  getLocale,
  getActiveLocale,
  registerCatalog,
  subscribe,
  isLocale,
  isActiveLocale,
  isPseudoLocale,
  isPseudoLocaleRequested,
  PSEUDO_LOCALE,
  PSEUDO_PREFIX,
  PSEUDO_SUFFIX,
  type Locale,
  type ActiveLocale,
  type PseudoLocale,
} from "./runtime.js";

export { resolveActiveLocale } from "./server-locale.js";

export { I18nProvider } from "./provider.js";
export { useLocaleSync } from "./sync.js";
export {
  readLocaleCookie,
  writeLocaleCookie,
  LOCALE_COOKIE,
} from "./cookie.js";
