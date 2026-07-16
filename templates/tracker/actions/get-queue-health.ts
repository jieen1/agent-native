import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { z } from "zod";

import { callOrchestratorTool } from "../server/lib/orchestrator-client.js";
import {
  getLastHealthRejection,
  getSchedulerState,
} from "../server/lib/scheduler-gate.js";

// Real health-gate status bar for the queue page (03-tracker.md §8: "vLLM ·
// CC 登录 · brain 槽位 三枚健康点 + 最近一次拒绝记录"). Reads TWO already-real
// orchestrator actions over the same signed MCP `tools/call` channel
// dispatch-to-orchestrator.ts uses (server/lib/orchestrator-client.ts) —
// never a third invented mechanism, never a direct cross-app DB read:
//  - get-runtime-status: claudeCodeLoggedIn/claudeCodeExpired (CC 登录) +
//    chatEngine/chatBaseUrl (the configured dev engine — reported as
//    "configured", never claimed "reachable": no live network probe exists).
//  - brain-queue-status: driverAlive/brainConcurrency/running/queued
//    (brain 槽位).
// Degrades to orchestratorReachable:false on any MCP failure rather than
// fabricating a healthy status.
interface RuntimeStatusResult {
  chatEngine?: string | null;
  chatModel?: string | null;
  chatBaseUrl?: string | null;
  claudeCodeLoggedIn?: boolean;
  claudeCodeExpired?: boolean;
  claudeCodeSubscription?: string | null;
}
interface BrainQueueStatusResult {
  brainConcurrency?: number;
  running?: number;
  queued?: number;
  driverAlive?: boolean;
  lastTickAt?: string | null;
  lastError?: string | null;
}

export default defineAction({
  description:
    "Real health-gate status for the execution queue: scheduler pause state " +
    "(local setting), Claude Code login + dev-engine config and brain " +
    "driver/concurrency (both read from the orchestrator over the same " +
    "signed MCP channel dispatch-to-orchestrator uses), and the last dispatch " +
    "rejection. Degrades to orchestratorReachable:false on MCP failure rather " +
    "than fabricating a healthy status.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

    const [scheduler, lastRejection] = await Promise.all([
      getSchedulerState(),
      getLastHealthRejection(),
    ]);

    let runtime: RuntimeStatusResult | null = null;
    let brain: BrainQueueStatusResult | null = null;
    let orchestratorReachable = true;
    let orchestratorError: string | null = null;
    try {
      const [runtimeRes, brainRes] = await Promise.all([
        callOrchestratorTool(ownerEmail, "get-runtime-status", {}),
        callOrchestratorTool(ownerEmail, "brain-queue-status", {}),
      ]);
      runtime = runtimeRes.data as RuntimeStatusResult;
      brain = brainRes.data as BrainQueueStatusResult;
    } catch (err) {
      orchestratorReachable = false;
      orchestratorError = err instanceof Error ? err.message : String(err);
    }

    return {
      scheduler,
      orchestratorReachable,
      orchestratorError,
      claudeCode: runtime
        ? {
            loggedIn: !!runtime.claudeCodeLoggedIn,
            expired: !!runtime.claudeCodeExpired,
            subscription: runtime.claudeCodeSubscription ?? null,
          }
        : null,
      devEngine: runtime
        ? {
            engine: runtime.chatEngine ?? null,
            model: runtime.chatModel ?? null,
            baseUrl: runtime.chatBaseUrl ?? null,
            configured: !!(runtime.chatEngine && runtime.chatBaseUrl),
          }
        : null,
      brain: brain
        ? {
            driverAlive: !!brain.driverAlive,
            concurrency: brain.brainConcurrency ?? null,
            running: brain.running ?? 0,
            queued: brain.queued ?? 0,
            lastError: brain.lastError ?? null,
            lastTickAt: brain.lastTickAt ?? null,
          }
        : null,
      lastRejection,
    };
  },
});
