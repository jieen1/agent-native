import { createH3SSRHandler } from "@agent-native/core/server/ssr-handler";
import { defineEventHandler } from "h3";

const ssr = createH3SSRHandler(
  () => import("virtual:react-router/server-build"),
);

export default defineEventHandler((event) => ssr(event));
