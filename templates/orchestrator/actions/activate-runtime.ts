import { defineAction } from "@agent-native/core";
import { writeAppSecret, readAppSecret } from "@agent-native/core/secrets";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { putSetting, deleteSetting } from "@agent-native/core/settings";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { nowIso, runtimeApiKeySecretKey } from "./_util.js";

// Activate a saved runtime.
//
//  - vLLM / OpenAI-compatible → drive the framework's built-in `ai-sdk:openai`
//    engine at the endpoint's baseUrl. We use the built-in engine (not a custom
//    one) so the framework's engine registry, status route, and model picker all
//    recognize it. The engine requires OPENAI_API_KEY, so if this runtime never
//    had a real key configured (save-runtime-config's optional `apiKey`), we
//    store a placeholder (vLLM ignores the key value) to satisfy the usability
//    gate. When a real key WAS configured for this runtime, we write that value
//    instead so remote OpenAI-compatible providers (OpenAI, Groq, DeepSeek, a
//    hosted vLLM behind auth) actually authenticate.
//
//  - Claude Code → write the `orchestrator-runtime` marker; execution routes to
//    the Claude Code harness (the chat engine is unchanged — a harness is not an
//    AgentEngine).
export default defineAction({
  description:
    "Activate a saved runtime. vLLM/OpenAI-compatible becomes the chat engine; Claude Code routes execution to the harness.",
  schema: z.object({ id: z.string() }),
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId();
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.runtimeConfigs)
      .where(
        and(
          eq(schema.runtimeConfigs.id, args.id),
          eq(schema.runtimeConfigs.ownerEmail, ownerEmail),
        ),
      )
      .limit(1);
    const rt = rows[0];
    if (!rt) throw new Error(`Runtime ${args.id} not found`);

    if (rt.kind === "claude-code") {
      await putSetting("orchestrator-runtime", {
        runtime: "claude-code",
        runtimeConfigId: rt.id,
      });
    } else {
      if (!rt.baseUrl) throw new Error("This runtime has no base URL");
      const configuredKey = await readAppSecret({
        key: runtimeApiKeySecretKey(rt.id),
        scope: "user",
        scopeId: ownerEmail,
      });
      // Prefer the real key configured for this runtime; fall back to the
      // placeholder — the OpenAI-compatible engine requires OPENAI_API_KEY to
      // be "configured", but local vLLM/LM Studio ignore the value.
      await writeAppSecret({
        key: "OPENAI_API_KEY",
        value: configuredKey?.value || "local-openai-compatible",
        scope: "user",
        scopeId: ownerEmail,
      });
      await putSetting("agent-engine", {
        engine: "ai-sdk:openai",
        model: rt.model ?? "",
        config: { baseUrl: rt.baseUrl },
      });
      await deleteSetting("orchestrator-runtime").catch(() => {});
    }

    const now = nowIso();
    await db
      .update(schema.runtimeConfigs)
      .set({ active: 0, updatedAt: now })
      .where(eq(schema.runtimeConfigs.ownerEmail, ownerEmail));
    await db
      .update(schema.runtimeConfigs)
      .set({ active: 1, updatedAt: now })
      .where(eq(schema.runtimeConfigs.id, rt.id));

    return { id: rt.id, kind: rt.kind, ok: true };
  },
});
