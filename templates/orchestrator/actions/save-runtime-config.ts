import { defineAction } from "@agent-native/core";
import { writeAppSecret } from "@agent-native/core/secrets";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { serializeModelList } from "../shared/model-list.js";
import { newId, nowIso, runtimeApiKeySecretKey } from "./_util.js";

// Create or update a saved runtime (vLLM / OpenAI-compatible / Claude Code).
export default defineAction({
  description:
    "Save a model runtime: a local vLLM / OpenAI-compatible endpoint, or Claude Code. Pass id to update. Optional apiKey (for remote OpenAI-compatible providers) is written to the secrets vault, never stored as a plain column.",
  schema: z.object({
    id: z.string().optional(),
    name: z.string(),
    kind: z.enum(["vllm", "openai-compatible", "claude-code"]).default("vllm"),
    baseUrl: z.string().optional(),
    model: z.string().optional(),
    // Optional extra model ids this endpoint serves (DESIGN §8.3 item4). A single
    // vLLM/OpenAI-compatible endpoint can host several models; this widens the
    // per-node ModelPicker without registering a custom engine (§8.5.1). `model`
    // remains the activation default.
    models: z.array(z.string()).optional(),
    // Real API key for a remote OpenAI-compatible provider (OpenAI, Groq,
    // DeepSeek, a hosted vLLM behind auth, ...). Leave unset for local
    // vLLM/LM Studio. Write-only: never returned by this or any other action —
    // stored in the secrets vault (see runtimeApiKeySecretKey), not as a
    // `runtime_configs` column.
    apiKey: z.string().optional(),
  }),
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId();
    const db = getDb();
    const now = nowIso();

    // Persist the model list as a JSON string array (additive `models` column).
    // Empty → null so the picker falls back to `model` (DESIGN §8.3 item4).
    const modelsJson = serializeModelList(args.models);
    const apiKey = args.apiKey?.trim();

    if (args.id) {
      await db
        .update(schema.runtimeConfigs)
        .set({
          name: args.name,
          kind: args.kind,
          baseUrl: args.baseUrl ?? null,
          model: args.model ?? null,
          models: modelsJson,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.runtimeConfigs.id, args.id),
            eq(schema.runtimeConfigs.ownerEmail, ownerEmail),
          ),
        );
      if (apiKey) {
        await writeAppSecret({
          key: runtimeApiKeySecretKey(args.id),
          value: apiKey,
          scope: "user",
          scopeId: ownerEmail,
        });
      }
      return { id: args.id, ok: true };
    }

    const id = newId("rt");
    await db.insert(schema.runtimeConfigs).values({
      id,
      name: args.name,
      kind: args.kind,
      baseUrl: args.baseUrl ?? null,
      model: args.model ?? null,
      models: modelsJson,
      active: 0,
      ownerEmail,
      orgId,
      createdAt: now,
      updatedAt: now,
    });
    // The row must exist before the secret can be scoped to its id.
    if (apiKey) {
      await writeAppSecret({
        key: runtimeApiKeySecretKey(id),
        value: apiKey,
        scope: "user",
        scopeId: ownerEmail,
      });
    }
    return { id, ok: true };
  },
});
