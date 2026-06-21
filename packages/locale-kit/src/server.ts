/**
 * locale-kit/server — server-only locale helpers.
 *
 * This entry is intended for SERVER modules (Nitro routes, plugins, background
 * jobs, action runners) that need to control or inspect the locale used by
 * `t()` / `tx()` for a given async context. It is deliberately separate from the
 * main `locale-kit` barrel so importing it from server code never drags any
 * DOM/React surface in.
 *
 * The key primitive is `runWithLocale(locale, fn)`: render any wrapped strings
 * (e.g. the build-time-wrapped transactional emails in
 * `@agent-native/core/server/email-templates`) in a KNOWN recipient's locale,
 * even from a background job with no request context. `resolveActiveLocale`
 * checks this override first, so the recipient locale beats the request user's
 * locale and the module-global.
 */

export {
  runWithLocale,
  setServerLocaleForEmail,
  getServerLocaleForEmail,
  resolveActiveLocale,
} from "./server-locale.js";

export { type Locale, isLocale } from "./runtime.js";
