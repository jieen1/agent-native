import path from "path";
import { createRequire } from "module";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "@agent-native/core/vite";
import { localeKitPlugin } from "locale-kit/vite";

const _require = createRequire(import.meta.url);
const ffmpegDir = path.resolve(
  path.dirname(_require.resolve("@ffmpeg/ffmpeg")),
  "../..",
);

export default defineConfig({
  plugins: [
    // Auto-wrap hardcoded English UI literals into runtime t()/tx() calls and
    // extract them into the en catalog. enforce:'pre' so it sees core's .tsx
    // source (aliased to packages/core/src in the monorepo).
    localeKitPlugin({
      include: [
        "/packages/core/src/client/",
        "/templates/clips/app/",
        "/templates/clips/components/",
        "/templates/clips/actions/",
        "/templates/clips/server/plugins/auth",
      ],
    }),
    reactRouter(),
  ],
  // shiki only runs in AssistantChat's useEffect — keep it out of the
  // CF Pages Functions bundle (25 MiB limit).
  ssrStubs: ["shiki"],
  fsAllow: [ffmpegDir],
  optimizeDeps: {
    exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"],
  },
});
