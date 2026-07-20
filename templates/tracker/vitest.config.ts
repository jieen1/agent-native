import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./app"),
      "@shared": path.resolve(__dirname, "./shared"),
    },
  },
  test: {
    // The existing *.spec.ts files in this template are standalone tsx scripts
    // that call process.exit() directly — they predate vitest and run via tsx.
    // Exclude them so vitest does not attempt to execute them as test suites.
    // Remove this exclude entry when those files are migrated to proper vitest tests.
    include: ["**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    exclude: [
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "shared/types.public-settings.spec.ts",
      "server/lib/submission-validation.spec.ts",
    ],
    passWithNoTests: true,
    // `pnpm test:fast` runs every template's suite concurrently on one
    // resource-constrained CI runner. Many tests here do real dynamic
    // imports plus several sequencer/DB round-trips per assertion, so the
    // vitest default (5000ms) is too tight under that load and intermittently
    // times out one test, whose forced abort then corrupts the isolated
    // SQLite temp file for whichever test runs next in the same worker
    // (SDLC-038 investigation, PR#22). Raising the default gives real
    // headroom without masking a genuinely slow/hanging test (20s is still
    // well short of the CI job's own timeout).
    testTimeout: 20000,
  },
});
