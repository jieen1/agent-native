// health-telemetry — F9's slice: writeback success/failure counters for the
// S10 health page's "调度器" (scheduler) card. See
// `server/writeback-telemetry.ts` for the full scope note on why this action
// only covers the writeback slice and not F7's separate 5-counter "遥测可信
// 卡" (that card's underlying schema/events don't exist on this branch — see
// the module-level comment in `server/writeback-telemetry.ts`).
//
// Design authority: docs/sdlc-impl-f5-f10.md §5B ("S10 健康页『调度器』卡加
// 一行『回写:最近成功/失败计数』(数据源 v3_events writeback.*)。").

import { defineAction } from "@agent-native/core";
import { z } from "zod";

import { computeWritebackTelemetry } from "../server/writeback-telemetry.js";

export default defineAction({
  description:
    "S10 health page data: writeback success/failure counters (回写:最近成功/" +
    "失败计数) over the trailing window, sourced from v3_events writeback.*. " +
    "Read-only.",
  schema: z.object({
    windowHours: z.number().int().positive().optional(),
  }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    return computeWritebackTelemetry(args.windowHours ?? 24);
  },
});
