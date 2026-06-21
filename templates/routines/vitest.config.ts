import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./app"),
    },
  },
  test: {
    include: ["**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    exclude: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      // Phase A5 production gate §1.5.20 item 2: the core routine modules must
      // stay >=80% line-covered. Scope coverage to the app's own logic — the
      // action handlers and the lib helpers they share — and exclude UI routes,
      // generated registries, type/barrel files, and the tests themselves.
      include: ["actions/**/*.ts", "app/lib/**/*.ts"],
      exclude: [
        "**/*.spec.ts",
        "**/*.test.ts",
        "**/*.d.ts",
        ".generated/**",
        "app/lib/tab-id.ts",
        "app/lib/app-config.ts",
      ],
      reporter: ["text", "json-summary"],
      thresholds: {
        lines: 80,
      },
    },
  },
});
