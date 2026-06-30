import { defineConfig } from "vitest/config";

// Dedicated unit-test config. The app's vite.config.ts pulls in the full
// React Router + @agent-native/core plugin pipeline (route codegen, SSR, etc.)
// which makes `vitest` extremely slow to start and is irrelevant to the
// server-side unit tests. All specs live under server/ and shared/ and run in
// a plain Node environment, so we bypass the app config entirely here.
export default defineConfig({
  test: {
    include: ["server/**/*.{spec,test}.ts", "shared/**/*.{spec,test}.ts"],
    environment: "node",
  },
});
