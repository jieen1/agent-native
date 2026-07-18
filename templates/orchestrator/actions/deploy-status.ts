import { defineAction } from "@agent-native/core";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import type { DeployStageEntry } from "../server/deploy/deploy-runner.js";

function parseJsonArray(raw: string): DeployStageEntry[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonStrings(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

// Single-snapshot read of one deploy run — mirrors workspaceCiWatch's poll
// idiom (v3-workspace.ts): no server-side polling loop, the client calls this
// again on its own cadence while the run is live.
export default defineAction({
  description:
    "Get one deploy run's real live status: current stage, full stage timeline, and outcome once terminal. Single snapshot — call again to poll.",
  schema: z.object({ deployRunId: z.string() }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.deployRuns)
      .where(eq(schema.deployRuns.id, args.deployRunId))
      .limit(1);
    if (!row) throw new Error(`Deploy run '${args.deployRunId}' not found`);
    return {
      id: row.id,
      target: row.target,
      apps: parseJsonStrings(row.apps),
      status: row.status,
      stage: row.stage,
      stageLog: parseJsonArray(row.stageLog),
      commitSha: row.commitSha,
      backupRef: row.backupRef,
      healthCheckResult: row.healthCheckResult,
      error: row.error,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      triggeredBy: row.triggeredBy,
    };
  },
});
