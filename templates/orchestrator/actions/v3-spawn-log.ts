/**
 * spawn.log — return the log artifact for a spawn (design §8.1).
 *
 * G21: new action file for missing spawn.log tool.
 */

import { defineAction } from "@agent-native/core";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getV3Db, v3Schema, resolveOwnerEmail } from "../server/db/index.js";

export const spawnLog = defineAction({
  description:
    "Return the log content for a V3 spawn. Fetches the log artifact referenced by " +
    "spawn.logRef, or returns null if no log is available (e.g. spawn is still pending).",
  schema: z.object({
    spawnId: z.string().min(1),
  }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    const db = getV3Db();

    const rows = await db
      .select({
        id: v3Schema.v3Spawns.id,
        status: v3Schema.v3Spawns.status,
        logRef: v3Schema.v3Spawns.logRef,
        agentName: v3Schema.v3Spawns.agentName,
        startedAt: v3Schema.v3Spawns.startedAt,
        completedAt: v3Schema.v3Spawns.completedAt,
        error: v3Schema.v3Spawns.error,
        errorClass: v3Schema.v3Spawns.errorClass,
      })
      .from(v3Schema.v3Spawns)
      // Fail-closed owner scope — a foreign spawn's log is not readable.
      .where(
        and(
          eq(v3Schema.v3Spawns.id, args.spawnId),
          eq(v3Schema.v3Spawns.ownerEmail, resolveOwnerEmail()),
        ),
      )
      .limit(1);

    if (!rows.length) {
      throw new Error(`Spawn '${args.spawnId}' not found`);
    }

    const s = rows[0];
    let log: string | null = null;

    if (s.logRef) {
      // logRef may point to an artifact id or a filesystem path
      const artRows = await db
        .select({ textContent: v3Schema.v3Artifacts.textContent })
        .from(v3Schema.v3Artifacts)
        .where(eq(v3Schema.v3Artifacts.id, s.logRef))
        .limit(1);

      if (artRows.length) {
        log = artRows[0].textContent ?? null;
      } else {
        // logRef may be a path reference — return it as-is for the caller
        log = `[log stored at: ${s.logRef}]`;
      }
    }

    return {
      spawnId: args.spawnId,
      agentName: s.agentName,
      status: s.status,
      startedAt: s.startedAt?.toISOString() ?? null,
      completedAt: s.completedAt?.toISOString() ?? null,
      error: s.error,
      errorClass: s.errorClass,
      log,
    };
  },
});
