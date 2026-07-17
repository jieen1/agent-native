// get-brain-fallback-engine — identity of the SDK/vLLM engine the brain falls
// back to when the managed Claude Code login is absent (server/brain/
// sdk-brain-session.ts's useSdkBrain path). Backs the S9 "引擎与模型" card's
// "兜底引擎" line.
//
// Reports IDENTITY + CONFIGURATION PRESENCE only (model id, endpoint host) —
// never a "健康" claim, since this action makes no live probe of the endpoint
// (that belongs to the S10 health page's vLLM health card). `configured`
// means an endpoint is set, not that it currently responds. Never returns the
// API key.

import { defineAction } from "@agent-native/core";
import { z } from "zod";

function endpointHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export default defineAction({
  description:
    "Return the identity (model id, endpoint host, configured presence — " +
    "NOT a live health probe) of the SDK/vLLM engine the orchestrator brain " +
    "falls back to when no managed Claude Code login is present. Backs the " +
    "S9 Brain console's '引擎与模型' fallback-engine line.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
    const baseUrl = process.env.OPENAI_BASE_URL?.trim() || null;
    const model = process.env.OPENAI_MODEL?.trim() || "claude-sonnet-4-6";
    return {
      model,
      endpointHost: baseUrl ? endpointHost(baseUrl) : null,
      configured: !!baseUrl,
    };
  },
});
