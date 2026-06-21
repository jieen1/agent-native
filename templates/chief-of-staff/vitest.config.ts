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
    include: ["**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    exclude: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      // Production gate §1.5.20 item 2: the named core briefing modules must
      // stay >=80% line-covered — the fan-out (`runFanout`), the digest /
      // truncation / deep-link / brain-routing helpers, the compile/update/get
      // briefing actions, and the SSR public reader. Scope coverage to that
      // logic and exclude pure framework glue with no app logic to test:
      //   - `run.ts`            CLI entrypoint (`runScript()`), no logic.
      //   - `hello.ts`          Phase 0 scaffold greeting, not briefing logic.
      //   - `navigate.ts` /     app-state/UI navigation glue (asserted via
      //     `view-screen.ts`    structured app-state, not line coverage).
      //   - `*-settings.ts`     thin action wrappers around the covered
      //                         `parseBriefingSettings` helper.
      //   - `shared/types.ts`   type-only barrel.
      include: [
        "actions/**/*.ts",
        "shared/**/*.ts",
        "server/lib/**/*.ts",
        "app/lib/briefing-notice.ts",
      ],
      exclude: [
        "**/*.spec.ts",
        "**/*.test.ts",
        "**/*.d.ts",
        ".generated/**",
        "shared/types.ts",
        "actions/run.ts",
        "actions/hello.ts",
        "actions/navigate.ts",
        "actions/view-screen.ts",
        "actions/get-briefing-settings.ts",
        "actions/update-briefing-settings.ts",
      ],
      reporter: ["text", "json-summary"],
      thresholds: {
        lines: 80,
      },
    },
  },
});
