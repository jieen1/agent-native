/**
 * Server-side, request-scoped locale resolution.
 *
 * On the client there is exactly one active locale: the module-global the
 * I18nProvider / `useLocaleSync()` keeps in sync with the UI. On the SERVER a
 * single Node process handles many users concurrently, so a module-global is
 * wrong — action result strings (`message` / `summary`, thrown errors) must be
 * resolved in the REQUEST user's locale, not whoever last toggled the global.
 *
 * This module keeps a per-email locale map and a resolver that, on the server,
 * reads the current request's user email from `@agent-native/core`'s
 * request-context and returns that user's locale when known. The core import is
 * guarded (optional dynamic import + try/catch) so locale-kit still loads in
 * environments where core's request-context is unavailable (CLI, tests, the
 * browser) — it simply falls back to the module-global locale.
 *
 * The map is populated by `setServerLocaleForEmail`, called from the
 * `change-language` action when it persists `u:<email>:locale`, and may be
 * lazily seeded from durable user settings on a server-side miss.
 *
 * Every piece of shared mutable state (the per-email map, the override
 * AsyncLocalStorage, the seed-attempt set) lives on the process-wide singleton
 * in `state.ts`. The runtime store (`runtime.ts`) reads the SAME singleton, so
 * `resolveActiveLocale` defined here and imported by `t()`/`tx()` always sees
 * the override set by `runWithLocale`, even when the two entry points are
 * bundled into separate chunks.
 */

import type { Locale } from "./runtime.js";
import { isLocale } from "./runtime.js";
import { getLocaleKitState, type LocaleAsyncLocalStorage } from "./state.js";

/**
 * Construct (once) the AsyncLocalStorage used for explicit locale overrides.
 * Returns null when AsyncLocalStorage is unavailable (browser, exotic runtime),
 * in which case `runWithLocale` degrades to a plain call with no override.
 *
 * The constructed store is memoized on the process-wide singleton so both
 * entry-point chunks share one AsyncLocalStorage instance.
 */
function getLocaleOverrideStore(): LocaleAsyncLocalStorage | null {
  const state = getLocaleKitState();
  if (state.localeOverrideStore !== undefined) return state.localeOverrideStore;
  if (!isServer()) {
    state.localeOverrideStore = null;
    return null;
  }
  try {
    const hooks = loadAsyncHooks();
    state.localeOverrideStore =
      hooks && typeof hooks.AsyncLocalStorage === "function"
        ? new hooks.AsyncLocalStorage()
        : null;
  } catch {
    state.localeOverrideStore = null;
  }
  return state.localeOverrideStore;
}

interface AsyncHooksModule {
  AsyncLocalStorage?: new () => LocaleAsyncLocalStorage;
}

/**
 * Load `node:async_hooks` on the server without a statically-analyzable import,
 * so the browser bundle never pulls it in. Tries, in order:
 *
 *   1. `process.getBuiltinModule("node:async_hooks")` — the ESM-safe way to
 *      reach a builtin in modern Node (works under pure ESM, where the CJS
 *      `require` indirection below is unavailable because `require` is not in
 *      scope). This is what makes the `runWithLocale` override resolve under
 *      ESM-only hosts and tsx.
 *   2. The shared runtime-`require` indirection, for CJS hosts / older runtimes
 *      that lack `getBuiltinModule`.
 *
 * Returns null when neither path yields the module (browser, exotic runtime),
 * in which case `runWithLocale` degrades to a plain call with no override.
 */
function loadAsyncHooks(): AsyncHooksModule | null {
  const getBuiltin = (process as { getBuiltinModule?: (id: string) => unknown })
    .getBuiltinModule;
  if (typeof getBuiltin === "function") {
    try {
      const mod = getBuiltin.call(process, "node:async_hooks");
      if (mod) return mod as AsyncHooksModule;
    } catch {
      // Fall through to the require indirection.
    }
  }
  const req = getRuntimeRequire();
  return req ? (req("node:async_hooks") as AsyncHooksModule) : null;
}

/**
 * Run `fn` with `locale` forced as the active locale for every synchronous and
 * awaited `t()` / `tx()` call made inside it (and inside anything it awaits).
 *
 * This is the clean primitive for rendering text in a KNOWN recipient's locale
 * — most importantly transactional emails, which render for a recipient who may
 * differ from the request user and are often sent from a background job with no
 * request context. Because core's `email-templates.ts` strings are wrapped by
 * the build-time plugin and resolve through `resolveActiveLocale`, a caller that
 * knows the recipient's locale can do:
 *
 *   import { runWithLocale } from "locale-kit/server";
 *   const rendered = await runWithLocale(recipientLocale, () =>
 *     renderInviteEmail({ ... }),
 *   );
 *   await sendEmail({ to, ...rendered });
 *
 * `resolveActiveLocale` checks this override FIRST — before the per-email map,
 * the request user, and the module-global — so the recipient locale wins even
 * inside an authenticated request for a different user. The override is scoped
 * strictly to `fn`'s async context and is automatically cleared when it
 * settles, so concurrent renders for different recipients never bleed.
 *
 * If AsyncLocalStorage is unavailable or `locale` is not a supported locale,
 * `fn` runs unchanged (resolution falls back to the request-user / global
 * chain). The return value of `fn` is passed through untouched.
 */
export function runWithLocale<R>(locale: Locale, fn: () => R): R {
  if (!isLocale(locale)) return fn();
  const store = getLocaleOverrideStore();
  if (!store) return fn();
  return store.run(locale, fn);
}

/** Read the explicit locale override for the current async context, if any. */
function readLocaleOverride(): Locale | undefined {
  const store = getLocaleKitState().localeOverrideStore;
  if (!store) return undefined;
  const value = store.getStore();
  return isLocale(value) ? value : undefined;
}

/** True on the server (no DOM). Kept here so runtime stays DOM-import-free. */
function isServer(): boolean {
  return typeof window === "undefined";
}

/**
 * Record a user's locale for subsequent server-side `t()` / `tx()` resolution
 * within this process. Called by `change-language` after it writes the durable
 * `u:<email>:locale` setting so later action messages in the same process pick
 * up the new locale immediately. Ignores unknown locales and empty emails.
 */
export function setServerLocaleForEmail(email: string, locale: Locale): void {
  if (!email || !isLocale(locale)) return;
  getLocaleKitState().serverLocaleByEmail.set(email, locale);
}

/** Read a user's recorded server-side locale, if any. */
export function getServerLocaleForEmail(email: string): Locale | undefined {
  return getLocaleKitState().serverLocaleByEmail.get(email);
}

/**
 * Resolve the current request's user email from core's request-context.
 *
 * The dependency on `@agent-native/core/server/request-context` is OPTIONAL and
 * never statically imported: a static import of that module would pull
 * `node:async_hooks` into the browser bundle and break it. Instead we resolve
 * the request user via two guarded, browser-safe paths, in order:
 *
 *   1. `getRequestUserEmail()` from core's request-context module, loaded with a
 *      synchronous CJS `require` obtained at runtime (never bundled). This is
 *      the documented core export, verified in
 *      `packages/core/src/server/request-context.ts`.
 *   2. Reading core's AsyncLocalStorage store directly from its global key
 *      (`globalThis.__agentNativeRequestContextAls`) when the require path is
 *      unavailable (e.g. an ESM-only host with no CJS require). This mirrors how
 *      `getRequestUserEmail` reads the store and needs no import at all.
 *
 * Every failure (not on the server, module missing, empty ALS, throw) is
 * swallowed so a lookup miss can never crash `t()`.
 */
function readRequestUserEmail(): string | undefined {
  if (!isServer()) return undefined;
  try {
    const mod = loadRequestContextModule();
    if (mod && typeof mod.getRequestUserEmail === "function") {
      const email = mod.getRequestUserEmail();
      if (typeof email === "string" && email.length > 0) return email;
      return undefined;
    }
    return readRequestUserEmailFromGlobal();
  } catch {
    return undefined;
  }
}

interface RequestContextModule {
  getRequestUserEmail?: () => string | undefined;
}

let requestContextModule: RequestContextModule | null | undefined;

/** Minimal shape of core's user-settings module for the lazy seed. */
interface UserSettingsModule {
  getUserSetting?: (
    email: string,
    key: string,
  ) => Promise<Record<string, unknown> | null>;
}

let userSettingsModule: UserSettingsModule | null | undefined;

/** Minimal shape of an AsyncLocalStorage store for the email lookup. */
interface AlsLike {
  getStore: () => { userEmail?: unknown } | undefined;
}

const ALS_GLOBAL_KEY = "__agentNativeRequestContextAls";

/**
 * Obtain a runtime `require` without a statically-analyzable import so the
 * browser bundle never tries to include `node:module` or the core server
 * module. Returns null when no CJS require is reachable.
 */
function getRuntimeRequire(): NodeRequire | null {
  try {
    // `module.createRequire` via an indirect, unanalyzable specifier. The
    // Function wrapper hides the dynamic require from Rollup's import scanner.
    const dynamicRequire = new Function("spec", "return require(spec);") as (
      spec: string,
    ) => unknown;
    const nodeModule = dynamicRequire("node:module") as {
      createRequire?: (from: string) => NodeRequire;
    };
    if (nodeModule && typeof nodeModule.createRequire === "function") {
      return nodeModule.createRequire(import.meta.url);
    }
  } catch {
    // No CJS require available.
  }
  return null;
}

/**
 * Lazily load core's request-context module exactly once, tolerating absence.
 * Cached as `null` after a failed attempt so repeated `t()` calls don't re-pay
 * the resolution cost or repeatedly throw.
 */
function loadRequestContextModule(): RequestContextModule | null {
  if (requestContextModule !== undefined) return requestContextModule;
  try {
    const req = getRuntimeRequire();
    requestContextModule = req
      ? (req(
          "@agent-native/core/server/request-context",
        ) as RequestContextModule)
      : null;
  } catch {
    requestContextModule = null;
  }
  return requestContextModule;
}

/**
 * Lazily load core's user-settings module exactly once, tolerating absence.
 * Loaded via the same unanalyzable runtime `require` as the request-context
 * module so the browser bundle never pulls core's server settings code in.
 * `getUserSetting` is the documented core export, verified in
 * `packages/core/src/settings/user-settings.ts` (re-exported from
 * `@agent-native/core/settings`). Cached as `null` after a failed attempt.
 */
function loadUserSettingsModule(): UserSettingsModule | null {
  if (userSettingsModule !== undefined) return userSettingsModule;
  try {
    const req = getRuntimeRequire();
    userSettingsModule = req
      ? (req("@agent-native/core/settings") as UserSettingsModule)
      : null;
  } catch {
    userSettingsModule = null;
  }
  return userSettingsModule;
}

/**
 * Best-effort, fire-and-forget seed of a user's locale from the durable
 * `u:<email>:locale` user setting on a server-side cache miss.
 *
 * `resolveActiveLocale` (and therefore `t()` / `tx()`) is synchronous, so this
 * cannot block the current call — it returns the module-global for THIS call
 * and only populates `serverLocaleByEmail` for SUBSEQUENT calls in the same
 * process. Every step is guarded so a missing module, a DB error, or a
 * malformed value can never crash `t()`. In-flight reads are deduped per email
 * so a burst of `t()` calls for one user issues at most one DB read.
 */
function lazySeedLocaleFromDurableSetting(email: string): void {
  const { seedAttemptedEmails } = getLocaleKitState();
  if (!email || seedAttemptedEmails.has(email)) return;
  seedAttemptedEmails.add(email);
  let mod: UserSettingsModule | null;
  try {
    mod = loadUserSettingsModule();
  } catch {
    return;
  }
  if (!mod || typeof mod.getUserSetting !== "function") return;
  let pending: Promise<Record<string, unknown> | null>;
  try {
    pending = mod.getUserSetting(email, "locale");
  } catch {
    return;
  }
  void Promise.resolve(pending)
    .then((value) => {
      const locale = value?.locale;
      if (isLocale(locale)) setServerLocaleForEmail(email, locale);
    })
    .catch(() => {
      // Swallow: a durable-setting read failure must never surface through t().
    });
}

/**
 * Fallback: read the active request's user email straight from core's
 * AsyncLocalStorage store on the global, the same store `getRequestUserEmail`
 * reads. No import required, so it works even when the require path is closed.
 */
function readRequestUserEmailFromGlobal(): string | undefined {
  const als = (globalThis as Record<string, unknown>)[ALS_GLOBAL_KEY] as
    | AlsLike
    | undefined;
  if (!als || typeof als.getStore !== "function") return undefined;
  const store = als.getStore();
  const email = store?.userEmail;
  return typeof email === "string" && email.length > 0 ? email : undefined;
}

/**
 * Resolve the locale that `t()` / `tx()` should use for the CURRENT call.
 *
 * Resolution order on the server:
 *   1. An explicit `runWithLocale` override active in this async context — the
 *      clean primitive for rendering a known recipient's text (e.g. emails).
 *   2. The request user's recorded locale, when the request has a user email.
 *   3. The module-global (kicking off a best-effort durable-setting seed on a
 *      cache miss for a known request user).
 * On the client it is always the module-global.
 *
 * `globalLocale` is passed in by the runtime (which owns the global) to avoid a
 * circular module dependency at evaluation time.
 */
export function resolveActiveLocale(globalLocale: Locale): Locale {
  if (!isServer()) return globalLocale;
  // (1) Explicit override wins over everything — recipient locale must beat the
  // request user's locale when rendering an email inside another user's request.
  const override = readLocaleOverride();
  if (override) return override;
  const email = readRequestUserEmail();
  if (!email) return globalLocale;
  const perUser = getLocaleKitState().serverLocaleByEmail.get(email);
  if (perUser) return perUser;
  // Cache miss for a known request user: kick off a best-effort, fire-and-forget
  // seed from the durable `u:<email>:locale` setting so LATER calls in this
  // process resolve in the user's chosen locale. This call still returns the
  // module-global — never blocks, never throws.
  lazySeedLocaleFromDurableSetting(email);
  return globalLocale;
}
