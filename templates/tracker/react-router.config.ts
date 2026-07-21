import type { Config } from "@react-router/dev/config";

// react-router v8 made every v7 `future.v8_*` flag this file used to opt into
// (middleware, split route modules, pass-through requests, trailing-slash-
// aware data requests, the Vite Environment API) unconditional default
// behavior — there is no longer a `future` flag for any of them.
export default {
  appDirectory: "app",
  ssr: true,
  routeDiscovery: { mode: "initial" },
} satisfies Config;
