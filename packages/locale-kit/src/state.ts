/**
 * Process-wide singleton state for locale-kit.
 *
 * The runtime store (`runtime.ts`) and the server-side resolver
 * (`server-locale.ts`) are reachable through DIFFERENT package entry points
 * (`locale-kit` vs `locale-kit/server`). Under bundling each entry can pull its
 * own copy of those modules into a separate chunk, which previously gave each
 * copy its OWN module-scope `let`/`const` state: a second `currentLocale`, a
 * second `serverLocaleByEmail` map, a second `runWithLocale` AsyncLocalStorage,
 * etc. The two copies then desynced — e.g. `runWithLocale("zh-CN", () => t(key))`
 * set the override on one copy while `t()` read the override store on the other,
 * so it returned English instead of the recipient locale.
 *
 * Fix: keep ALL shared mutable locale state on ONE object stored on
 * `globalThis` under a unique key, exactly like core's request-context stores
 * its AsyncLocalStorage on `globalThis.__agentNativeRequestContextAls`. Every
 * module reads/writes that single object through the typed accessor below, so
 * duplicate module copies still share one source of truth.
 */

import type { ActiveLocale, Locale } from "./runtime.js";

/**
 * Minimal shape of an AsyncLocalStorage instance carrying an explicit locale
 * override for the duration of a callback. Typed structurally so this module
 * needs no static import of `node:async_hooks` (which would break the browser
 * bundle).
 */
export interface LocaleAsyncLocalStorage {
  getStore: () => Locale | undefined;
  run: <R>(store: Locale, fn: () => R) => R;
}

/**
 * The single shared locale state object. Lives on `globalThis` so every copy of
 * the locale-kit modules (across entry-point chunks or duplicated installs)
 * reads and writes the SAME instance.
 */
export interface LocaleKitState {
  /**
   * The module-global active locale (client UI locale / server fallback). Wider
   * than {@link Locale} because the built-in pseudo-locale (`"zz"`) is a valid
   * ACTIVE locale used by the completeness render sweep, even though it is never
   * a real catalog/cookie locale.
   */
  currentLocale: ActiveLocale;
  /** Per-locale string catalogs, keyed by English source string. */
  catalogs: Record<Locale, Record<string, string>>;
  /** Subscribers notified on locale/catalog changes. */
  listeners: Set<() => void>;
  /** Per-user server-side locale, keyed by email. Empty on the client. */
  serverLocaleByEmail: Map<string, Locale>;
  /**
   * Lazily-constructed AsyncLocalStorage for explicit `runWithLocale` overrides.
   * `undefined` before first use; `null` once a build attempt has failed (e.g.
   * no AsyncLocalStorage available, browser).
   */
  localeOverrideStore: LocaleAsyncLocalStorage | null | undefined;
  /** Emails whose durable locale has been (or is being) lazily seeded. */
  seedAttemptedEmails: Set<string>;
}

const STATE_GLOBAL_KEY = "__localeKitState" as const;

type GlobalWithLocaleKitState = typeof globalThis & {
  [STATE_GLOBAL_KEY]?: LocaleKitState;
};

function createInitialState(): LocaleKitState {
  return {
    currentLocale: "zh-CN",
    catalogs: { en: {}, "zh-CN": {} },
    listeners: new Set<() => void>(),
    serverLocaleByEmail: new Map<string, Locale>(),
    localeOverrideStore: undefined,
    seedAttemptedEmails: new Set<string>(),
  };
}

/**
 * Return the process-wide locale-kit state, creating and storing it on
 * `globalThis` on first access. All locale-kit modules MUST route shared state
 * reads/writes through this accessor so duplicate module copies stay in sync.
 */
export function getLocaleKitState(): LocaleKitState {
  const globalRef = globalThis as GlobalWithLocaleKitState;
  let state = globalRef[STATE_GLOBAL_KEY];
  if (!state) {
    state = createInitialState();
    globalRef[STATE_GLOBAL_KEY] = state;
  }
  return state;
}
