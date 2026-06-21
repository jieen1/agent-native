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
        "/templates/forms/app/",
        "/templates/forms/components/",
        "/templates/forms/actions/",
        "/templates/forms/server/plugins/auth",
      ],
    }),
    reactRouter(),
  ],
  optimizeDeps: {
    include: [
      "@hookform/resolvers",
      "@radix-ui/react-aspect-ratio",
      "date-fns",
      "embla-carousel-react",
      "input-otp",
      "nanoid",
      "react-day-picker",
      "react-resizable-panels",
      "recharts",
      "vaul",
    ],
  },
  // shiki only runs in AssistantChat's useEffect — keep it out of the
  // CF Pages Functions bundle (25 MiB limit).
  ssrStubs: ["shiki"],
});
