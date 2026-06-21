import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "@agent-native/core/vite";
import { localeKitPlugin } from "locale-kit/vite";

export default defineConfig({
  plugins: [
    // Auto-wrap hardcoded English UI literals into runtime t()/tx() calls and
    // extract them into the en catalog. enforce:'pre' so it sees core's .tsx
    // source (aliased to packages/core/src in the monorepo).
    localeKitPlugin({
      include: [
        "/packages/core/src/client/",
        "/templates/brain/app/",
        "/templates/brain/components/",
        "/templates/brain/actions/",
        "/templates/brain/server/plugins/auth",
      ],
    }),
    reactRouter(),
  ],
});
