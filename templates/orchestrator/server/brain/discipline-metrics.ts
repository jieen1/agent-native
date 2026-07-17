// Brain discipline metrics — the S9 "纪律指标" card's data source (04 §6:
// "memory 红线可观察化: 本线程 workflowRun 次数 · vLLM 工人 token 增量 ·
// 直改文件告警数 — 'brain 必须经 DAG 干活' 的证据仪表").
//
// workflowRun call count is client-computed from the already-loaded transcript
// (every tool_use event IS the full history for a thread — no server query
// needed). This module covers the two counters the transcript can't answer:
//   - deniedFileEdits: THIS thread's `tool.denied` spawn_events rows (written
//     by tool-denied.ts's maybeLogToolDenied whenever the brain's CC child
//     asked for a tool outside its phase's allowed face — the direct-write
//     guardrail actually firing).
//   - vllmTokensToday: today's total vLLM worker token usage (input+output),
//     GLOBAL (not thread-scoped — matches the prototype's "今日" label),
//     excluding usage_suspect rows per the telemetry-trust contract (04 §10:
//     suspect data must never be silently folded into aggregates).
//
// Row-fetch-then-reduce-in-JS (mirrors writeback-telemetry.ts) for the same
// testability reasons as harness-status.ts.

import { and, eq, gte } from "drizzle-orm";

import { getV3Db, v3Schema } from "../db/index.js";
import { brainSpawnKey } from "./tool-denied.js";

export interface BrainDisciplineMetrics {
  /** `tool.denied` spawn_events rows for this thread's brain: key. */
  deniedFileEdits: number;
  /** Today's total vLLM worker tokens (input+output), owner-scoped, GLOBAL. */
  vllmTokensToday: number;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** True when a spawn's engine/model ref looks like the vLLM worker path. */
function isVllmRef(engineRef: string | null, modelRef: string | null): boolean {
  const ref = `${engineRef ?? ""} ${modelRef ?? ""}`.toLowerCase();
  return ref.includes("vllm") || ref.includes("qwen");
}

export async function getDisciplineMetrics(
  threadId: string,
  ownerEmail: string,
): Promise<BrainDisciplineMetrics> {
  const db = getV3Db();
  const spawnKey = brainSpawnKey(threadId);

  let deniedFileEdits = 0;
  try {
    const rows = await db
      .select({ type: v3Schema.spawnEvents.type })
      .from(v3Schema.spawnEvents)
      .where(eq(v3Schema.spawnEvents.spawnId, spawnKey))
      .limit(1000);
    deniedFileEdits = rows.filter((r) => r.type === "tool.denied").length;
  } catch {
    deniedFileEdits = 0;
  }

  let vllmTokensToday = 0;
  try {
    const rows = await db
      .select({
        engineRef: v3Schema.v3Spawns.engineRef,
        modelRef: v3Schema.v3Spawns.modelRef,
        tokensInput: v3Schema.v3Spawns.tokensInput,
        tokensOutput: v3Schema.v3Spawns.tokensOutput,
        usageSuspect: v3Schema.v3Spawns.usageSuspect,
      })
      .from(v3Schema.v3Spawns)
      .where(
        and(
          eq(v3Schema.v3Spawns.ownerEmail, ownerEmail),
          gte(v3Schema.v3Spawns.startedAt, startOfToday()),
        ),
      )
      .limit(5000);
    for (const r of rows) {
      if (r.usageSuspect === 1) continue;
      if (!isVllmRef(r.engineRef, r.modelRef)) continue;
      vllmTokensToday += (r.tokensInput ?? 0) + (r.tokensOutput ?? 0);
    }
  } catch {
    vllmTokensToday = 0;
  }

  return { deniedFileEdits, vllmTokensToday };
}
