import { AgentActionStopError, defineAction } from "@agent-native/core";
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

      // Builtin-read-only and "exists but I lack write access" (private,
      // owned by someone else) must read identically — otherwise the error
      // text tells a prober which case they hit (existence/ownership leak,
      // orchestrator-agents-pool-design-review.md §1.4.5).
      const access = await resolveAccess("agent_def", ex.id);
      const canWrite = ex.builtin === 0 && !!access && access.role !== "viewer";
      if (!canWrite) {
        // Plain Error is masked to a generic 500 by action-routes.ts before it
        // reaches the browser toast — this message must be an
        // AgentActionStopError (or carry statusCode<500) to surface at all.
        throw new AgentActionStopError("该名称已被占用");
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
      // Worker agent defs are name-globally-unique and dispatched by name
      // with no access filtering (server/agent-loader.ts's loadAgent) — a
      // "private" agent would be an unkeepable promise (invisible to other
      // users' DAG nodes that still execute it). New agents are always
      // shared; see orchestrator-agents-pool-design-review.md §1.4.3.
      visibility: "public",
    });

    return { id, name, ok: true };
  },
});
