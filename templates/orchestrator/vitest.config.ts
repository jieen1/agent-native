import { defineConfig } from "vitest/config";

// Dedicated unit-test config. The app's vite.config.ts pulls in the full
// React Router + @agent-native/core plugin pipeline (route codegen, SSR, etc.)
// which makes `vitest` extremely slow to start and is irrelevant to the
// server-side unit tests. All specs live under server/, shared/, and actions/
// and run in a plain Node environment, so we bypass the app config entirely
// here. `actions/**` was added for F10's nodeRetry/runCancel action-level
// tests (T-F10-06/07, docs/sdlc-impl-f5-f10.md §6A) — the first actions/*.ts
// unit tests in this template.
//
// `app/**/*.ts` (NOT `.tsx`) was added for the s7-run-detail DAG layout fix —
// dag-layout.ts is a pure, framework-agnostic module with no React import, so
// it tests fine in this same plain Node environment. This deliberately does
// NOT add jsdom/React Testing Library or include `.tsx` component tests —
// that would be a much bigger test-infra change than this fix warrants; the
// component layer (DagVisualizer.tsx etc.) stays covered by manual/deployed
// verification instead.
export default defineConfig({
  test: {
    include: [
      "server/**/*.{spec,test}.ts",
      "shared/**/*.{spec,test}.ts",
      "actions/**/*.{spec,test}.ts",
      "app/**/*.{spec,test}.ts",
    ],
    environment: "node",
  },
});
