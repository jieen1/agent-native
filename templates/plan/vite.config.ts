import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "@agent-native/core/vite";
import { localeKitPlugin } from "locale-kit/vite";

export default defineConfig({
  plugins: [
    // Auto-wrap hardcoded English UI literals into runtime t()/tx() calls and
    // extract them into the shared en catalog. enforce:'pre' so it sees core's
    // .tsx source (aliased to packages/core/src in the monorepo).
    localeKitPlugin({
      include: [
        "/packages/core/src/client/",
        "/templates/plan/app/",
        "/templates/plan/components/",
        "/templates/plan/actions/",
        "/templates/plan/server/plugins/auth",
      ],
    }),
    reactRouter(),
  ],
  // Browser-only renderers run in useEffect — keep them out of the CF Pages
  // Functions bundle (25 MiB limit) and away from SSR DOM/canvas shims.
  ssrStubs: [
    "shiki",
    "mermaid",
    "@excalidraw/excalidraw",
    "@excalidraw/mermaid-to-excalidraw",
  ],
});
