/**
 * spawn.cancel — cancel a pending or running ad-hoc spawn (design §8.1).
 *
 * G21: new action file for missing spawn.cancel tool.
 */

import { defineAction } from "@agent-native/core";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getV3Db, v3Schema } from "../server/db/v3.js";

export const spawnCancel = defineAction({
  description:
    "Cancel a V3 spawn. Only pending or running spawns can be cancelled. " +
    "Sets spawn status to cancelled and records completedAt.",
  schema: z.object({
    spawnId: z.string().min(1),
  }),
  run: async (args) => {
    const db = getV3Db();

    const rows = await db
      .select({ id: v3Schema.v3Spawns.id, status: v3Schema.v3Spawns.status })
      .from(v3Schema.v3Spawns)
      .where(eq(v3Schema.v3Spawns.id, args.spawnId))
      .limit(1);

    if (!rows.length) {
      throw new Error(`Spawn '${args.spawnId}' not found`);
    }

    const prev = rows[0].status;
    if (!["pending", "running"].includes(prev)) {
      throw new Error(`Spawn is already ${prev}; can only cancel pending or running spawns`);
    }

    await db
      .update(v3Schema.v3Spawns)
      .set({ status: "cancelled" as any, completedAt: new Date() })
      .where(eq(v3Schema.v3Spawns.id, args.spawnId));

    return { spawnId: args.spawnId, previousStatus: prev, status: "cancelled" };
  },
});
