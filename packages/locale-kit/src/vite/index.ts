/**
 * locale-kit/vite — build-time auto-i18n plugin.
 *
 * `localeKitPlugin()` is a Vite plugin (`enforce: "pre"`) that rewrites
 * hardcoded English UI literals into runtime `t()` / `tx()` calls at build /
 * dev transform time, and extracts every wrapped English string as a key into
 * the `en` catalog. The English source string IS the key.
 *
 * It NEVER edits source on disk. It only rewrites the module text Vite hands to
 * the browser / SSR bundle. This lets it localize the shared `@agent-native/core`
 * chrome (which the monorepo aliases to `packages/core/src`) with zero edits to
 * core.
 *
 * The transform is idempotent: a literal already inside a `t()` / `tx()` call
 * (including P1's manual wraps) is left untouched, so re-running a build never
 * double-wraps.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { transformModule, type TransformOutput } from "./transform.js";
import { CatalogWriter } from "./catalog.js";

/**
 * Resolve the locale-kit package root from this module's location. Works
 * whether this file runs from `src/vite/` (app Vite transpiles TS) or
 * `dist/vite/` (the compiled entry imported by a Vite config). Walks up until
 * it finds the package.json named "locale-kit".
 */
function findPackageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const pkg = path.join(dir, "package.json");
    try {
      if (fs.existsSync(pkg)) {
        const parsed = JSON.parse(fs.readFileSync(pkg, "utf-8")) as {
          name?: string;
        };
        if (parsed.name === "locale-kit") return dir;
      }
    } catch {
      // Unreadable package.json — keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: assume two levels up from this module's dir (src|dist /vite).
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

const PACKAGE_ROOT = findPackageRoot();

export interface LocaleKitPluginOptions {
  /**
   * Path fragments (POSIX, `/`-separated) a module id must contain to be
   * processed. Defaults cover the core client chrome plus a single app's UI;
   * pass an explicit list to scope to a specific template.
   */
  include?: string[];
  /**
   * Absolute path to the `en` catalog JSON written by extraction. Defaults to
   * this package's `src/catalogs/en.json`.
   */
  enPath?: string;
}

// The en catalog and runtime entry are always the SOURCE files under src/,
// regardless of whether this plugin module loads from src/ or dist/. Extraction
// must always grow the real source catalog (the runtime imports it), and the
// injected `import { t, tx } from "locale-kit"` must resolve to the runtime
// source so it works even from modules whose own package (e.g.
// @agent-native/core) does not depend on locale-kit — keeping core edit-free.
const DEFAULT_EN_PATH = path.join(PACKAGE_ROOT, "src", "catalogs", "en.json");
const RUNTIME_ENTRY = path.join(PACKAGE_ROOT, "src", "index.ts");

const DEFAULT_INCLUDE = ["/packages/core/src/client/"];

/**
 * Core SERVER-side i18n surfaces that are ALWAYS wrapped, regardless of the
 * per-template `include` argument. These are the specific core paths that emit
 * user-visible / recipient-visible text from the server (P6):
 *
 *   - onboarding step title/description/label (rendered during authenticated
 *     setup — resolves via the request user's locale through
 *     resolveActiveLocale).
 *   - transactional email renderers + the shared renderEmail helper (invite /
 *     verify / reset; may be sent to a RECIPIENT who differs from the request
 *     user — resolve via runWithLocale(recipientLocale, …) when the caller
 *     knows the recipient).
 *   - default login-page marketing (pre-auth; resolves to global/en until a
 *     locale is resolvable — see the LIMITATION note in the package README).
 *   - notification channel copy.
 *
 * Scoped to these exact paths so the plugin never wraps core's internal log /
 * diagnostic strings: we deliberately do NOT include all of
 * `/packages/core/src/server`.
 */
const ALWAYS_INCLUDE: readonly string[] = [
  "/packages/core/src/onboarding/",
  "/packages/core/src/server/email-templates",
  "/packages/core/src/server/email-template",
  "/packages/core/src/server/auth-marketing",
  "/packages/core/src/notifications/",
];

const PROCESS_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"];

/** Normalize a Vite module id: drop the query string and use `/` separators. */
function normalizeId(id: string): string {
  const withoutQuery = id.split("?")[0] ?? id;
  return withoutQuery.replace(/\\/g, "/");
}

/** Whether a normalized id is eligible for transformation. */
function shouldProcess(normalized: string, include: string[]): boolean {
  if (normalized.includes("/node_modules/.pnpm/")) return false;
  if (/\.(spec|test)\.[cm]?[jt]sx?$/.test(normalized)) return false;
  if (normalized.endsWith(".d.ts")) return false;
  if (!PROCESS_EXTENSIONS.some((ext) => normalized.endsWith(ext))) return false;
  return include.some((fragment) => normalized.includes(fragment));
}

export function localeKitPlugin(options: LocaleKitPluginOptions = {}): Plugin {
  const base =
    options.include && options.include.length > 0
      ? options.include
      : DEFAULT_INCLUDE;
  // The core server i18n surfaces are ALWAYS in scope on top of whatever the
  // template passed, so every template's SSR / nitro build wraps onboarding,
  // email, auth-marketing, and notification strings — even templates that pass
  // a tight per-app include. De-duplicated to keep `shouldProcess` cheap.
  const include = [...new Set([...base, ...ALWAYS_INCLUDE])];
  const enPath = options.enPath ?? DEFAULT_EN_PATH;
  const writer = new CatalogWriter(enPath);

  return {
    name: "locale-kit-extract",
    enforce: "pre",
    apply: () => true,

    config() {
      // Make the injected bare `locale-kit` import resolvable from any module
      // (including core, which does not depend on locale-kit). An exact-match
      // alias so it never swallows `locale-kit/vite` etc.
      return {
        resolve: {
          alias: [{ find: /^locale-kit$/, replacement: RUNTIME_ENTRY }],
        },
      };
    },

    transform(code: string, id: string) {
      const normalized = normalizeId(id);
      if (!shouldProcess(normalized, include)) return null;

      let result: TransformOutput | null;
      try {
        result = transformModule(code, normalized);
      } catch {
        // Never break the build on a parse/transform error — leave the module
        // untouched and let downstream tooling report any real syntax issue.
        return null;
      }
      if (!result) return null;

      if (result.keys.length > 0) {
        writer.add(result.keys);
        writer.flush();
      }
      return { code: result.code, map: result.map };
    },

    buildEnd() {
      writer.flush();
    },
  };
}

export default localeKitPlugin;
