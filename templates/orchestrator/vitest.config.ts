import path from "node:path";

import { defineConfig } from "vitest/config";

// Dedicated unit-test config. The app's vite.config.ts pulls in the full
// React Router + @agent-native/core plugin pipeline (route codegen, SSR, etc.)
// which makes `vitest` extremely slow to start and is irrelevant to the
// server-side unit tests. All specs live under server/, shared/, and actions/
// and run in a plain Node environment, so we bypass the app config entirely
// here. `actions/**` was added for F10's nodeRetry/runCancel action-level
// tests (T-F10-06/07, docs/sdlc-impl-f5-f10.md §6A) — the first actions/*.ts
// unit tests in this template. `app/components/**` was added for the Foundry
// design-system component ports (StatusRing/StatusIcon/PriorityBars/
// ActorAvatar) — these opt into `happy-dom` per-file via the
// `@vitest-environment` pragma, same as templates/tracker/vitest.config.ts;
// the global environment below stays "node" for the server/shared/actions
// suites.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./app"),
      "@shared": path.resolve(__dirname, "./shared"),
    },
  },
  test: {
    include: [
      "server/**/*.{spec,test}.ts",
      "shared/**/*.{spec,test}.ts",
      "actions/**/*.{spec,test}.ts",
      "app/components/**/*.{spec,test}.tsx",
    ],
    environment: "node",
  },
});
