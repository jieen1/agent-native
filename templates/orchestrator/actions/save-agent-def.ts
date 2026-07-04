import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { resolveAccess } from "@agent-native/core/sharing";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { newId, nowIso } from "./_util.js";

// Create or update an agent definition by `name` (DESIGN §7).
// Upserts on name: existing → update (not viewer), new → insert.
// Builtin agents cannot be modified.
export default defineAction({
  description:
    "Create or update an agent definition (DESIGN §7). Upserts by `name`. Builtin agents are read-only. Fields: name, engine, model, tools (string[]), systemPrompt, description, runtime (derived from engine if omitted).",
  schema: z.object({
    name: z.string().min(1),
    engine: z.string().min(1),
    model: z.string().min(1),
    tools: z.array(z.string()).default([]),
    systemPrompt: z.string().default(""),
    description: z.string().optional(),
    runtime: z.string().optional(),
  }),
  run: async (args) => {
    const db = getDb();
    const now = nowIso();
    const name = args.name.trim();
    if (!name) throw new Error("Agent name is required");

    const existing = await db
      .select()
      .from(schema.agentDefs)
      .where(eq(schema.agentDefs.name, name))
      .limit(1);

    // ── Runtime derivation from engine ────────────────────────────────
    let engine = args.engine;
    let runtime = args.runtime;

    if (!runtime) {
      if (engine === "acp:claude-code") {
        // acp:claude-code is really a runtime prefix, not an engine name.
        // Rewrite: engine="claude-code", runtime="acp:claude-code"
        engine = "claude-code";
        runtime = "acp:claude-code";
      } else if (engine === "vllm") {
        runtime = "none";
      } else {
        // ai-sdk:anthropic, ai-sdk:openai, etc.
        runtime = "none";
      }
    }

    // ── Existing agent: update ─────────────────────────────────────────
    if (existing.length > 0) {
      const ex = existing[0] as any;

      if (ex.builtin !== 0) {
        throw new Error("Builtin agent is read-only");
      }

      const access = await resolveAccess("agent_def", ex.id);
      if (!access) throw new Error(`Agent '${name}' not found`);
      if (access.role === "viewer") {
        throw new Error("Read-only access");
      }

      await db
        .update(schema.agentDefs)
        .set({
          engine,
          model: args.model,
          tools: JSON.stringify(args.tools),
          systemPrompt: args.systemPrompt,
          description: args.description ?? ex.description ?? "",
          runtime,
          version: ex.version + 1,
          updatedAt: now,
        })
        .where(eq(schema.agentDefs.id, ex.id));

      return { id: ex.id, name, ok: true };
    }

    // ── New agent: insert ──────────────────────────────────────────────
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId();
    const id = newId("agdef");

    await db.insert(schema.agentDefs).values({
      id,
      name,
      engine,
      model: args.model,
      tools: JSON.stringify(args.tools),
      systemPrompt: args.systemPrompt,
      description: args.description ?? "",
      runtime,
      builtin: 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
      ownerEmail,
      orgId,
      visibility: "private",
    });

    return { id, name, ok: true };
  },
});